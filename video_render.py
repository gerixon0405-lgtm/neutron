"""Render a reviewed Editor V1 timeline. Media paths come only from the desktop job."""
from array import array
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import wave

MEDIA = {".png", ".jpg", ".jpeg", ".webp"}
GRADES = {"clean":"", "teal":",colorbalance=bs=.10:gs=.04:rh=.08,vignette",
          "mono":",hue=s=0,eq=contrast=1.17,vignette",
          "amber":",colorbalance=rs=.08:bs=-.12:rh=.10,vignette"}
FFMPEG = os.environ.get("NEUTRON_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NEUTRON_FFPROBE") or shutil.which("ffprobe")
FPS = 30


def emit(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def call(args, directory=None):
    if not args[0]:
        raise ValueError("Az FFmpeg vagy az ffprobe hiányzik. Telepítsd őket a PATH-ra.")
    with subprocess.Popen(args, cwd=directory, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0)) as child:
        while True:
            try:
                out, err = child.communicate(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                if directory and (Path(directory)/"cancel").exists():
                    child.kill()
                    child.communicate()
                    raise ValueError("Megszakítva.")
        if child.returncode:
            error=err.decode("utf8","replace").strip().splitlines()
            raise ValueError("Videófeldolgozási hiba: " + (" / ".join(error[-3:]) or str(child.returncode)))
        return out


@lru_cache(maxsize=1)
def encoder():
    encoders=call([FFMPEG,"-hide_banner","-encoders"]).decode("utf8","replace")
    if re.search(r"\blibx264\b",encoders):
        return ["-c:v","libx264","-preset","veryfast","-crf","19","-threads","2"]
    if re.search(r"\blibopenh264\b",encoders):
        return ["-c:v","libopenh264","-b:v","5M","-threads","2"]
    raise ValueError("Az FFmpeg build nem tartalmaz H.264 videókódolót (libx264 vagy libopenh264).")


def inspect(file, directory=None):
    doc=json.loads(call([FFPROBE,"-v","error","-show_format","-show_streams","-of","json",file],directory))
    streams=doc.get("streams",[])
    video=next((s for s in streams if s["codec_type"]=="video" and not s.get("disposition",{}).get("attached_pic")),None)
    return {"duration":float(doc.get("format",{}).get("duration") or 0),
            "width":video["width"] if video else 0,"height":video["height"] if video else 0,
            "audio":any(s["codec_type"]=="audio" for s in streams)}


def scenes(plan, assets, duration):
    start=max(0,min(round(float(plan["start"])*FPS),round(duration*FPS)))
    end=min(round(float(plan["end"])*FPS),math.floor(duration*FPS))
    if end-start < FPS:
        raise ValueError("A kivágat legyen legalább egy másodperc.")
    current=start
    prepared=[]
    for shot in sorted(plan.get("shots",[]),key=lambda item:item["at"]):
        pos=min(end,max(current,round(shot["at"]*FPS)))
        until=min(end,round((shot["at"]+shot["len"])*FPS))
        if until<=pos:
            continue
        if pos>current:
            prepared.append((current,pos,{}))
        prepared.append((pos,until,shot if shot.get("asset") in assets or shot.get("device")=="punch" else {}))
        current=until
    if current<end:
        prepared.append((current,end,{}))
    return start,end,prepared


def segment(source, assets, shot, at, length, size, out, directory):
    width,height=size
    selected=assets.get(shot.get("asset"))
    still=selected and Path(selected).suffix.lower() in MEDIA
    if still:
        inputs=["-loop","1","-framerate",str(FPS),"-i",selected]
    elif selected:
        inputs=["-stream_loop","-1","-ss",str(max(0,shot.get("offset",0))),"-i",selected]
    else:
        inputs=["-ss",str(at),"-i",source]
    device=shot.get("device")
    zoom=1.12 if device=="punch" else 1
    scaled_w,scaled_h=2*math.ceil(width*zoom/2),2*math.ceil(height*zoom/2)
    filters=f"scale={scaled_w}:{scaled_h}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"
    if still and device in ("push","tile"):
        filters+=f",zoompan=z='min(1+on*0.0023,1.12)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={width}x{height}:fps={FPS}"
    else:
        filters+=f",fps={FPS}"
    if selected:
        filters+=GRADES.get(shot.get("grade"),GRADES["teal"])
        if device=="tile":
            # Staggered three-column reveal, with a white frame before each column.
            for column in range(3):
                x=column*width//3
                wide=(column+1)*width//3-x+1
                filters+=f",drawbox=x={x}:y=0:w={wide}:h=ih:c=black:t=fill:enable='lt(t,{column/FPS})'"
                filters+=f",drawbox=x={x}:y=0:w={wide}:h=ih:c=white:t=fill:enable='gte(t,{column/FPS})*lt(t,{(column+1)/FPS})'"
    filters+=",format=yuv420p"
    call([FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-filter_threads","1",*inputs,
          "-an","-vf",filters,"-frames:v",str(length),*encoder(),"-pix_fmt","yuv420p",out],directory)


def captions(words, start, end, path):
    def stamp(seconds):
        cs=round(seconds*100)
        return f"{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}"
    rows=[]
    for word in words:
        left=max(start,word["start"])
        right=min(end,max(word["end"],left+.05))
        if left>=right:continue
        text=re.sub(r"[{}\\\r\n]", " ",word["text"]).strip()
        if text:
            rows.append(f"Dialogue: 0,{stamp(left-start)},{stamp(right-start)},Base,,0,0,0,,{text}")
    if not rows:return False
    header="""[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Base,Arial,43,&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,3,1,2,54,54,78,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    path.write_text(header+"\n".join(rows)+"\n",encoding="utf-8")
    return True


def clicks(length, markers, dest):
    rate=16000
    samples=array("h",[0])*math.ceil(length*rate)
    for i,sec in enumerate(markers):
        offset=round((sec+.009)*rate)
        for n in range(min(185,len(samples)-offset)):
            click=(.7*math.sin(n*(1.73+.11*(i%4)))+.3*math.sin(2.63*n))*math.exp(-n/29)
            samples[offset+n]=int(3600*click)
    if sys.byteorder=="big":samples.byteswap()
    with wave.open(str(dest),"wb") as out:
        out.setparams((1,2,rate,0,"NONE","not compressed"))
        out.writeframes(samples.tobytes())


def render(job, directory):
    source=job["source"]
    info=inspect(source,directory)
    if not info["width"] or not info["duration"]:
        raise ValueError("A kiválasztott fájlban nincs renderelhető videó.")
    options=job["options"]
    tall=options["format"]=="9:16"; square=options["format"]=="1:1"
    short=1080 if options["quality"]=="1080" else 720
    long=short*16//9
    size=(short,long) if tall else (short,short) if square else (long,short)
    start,end,prepared=scenes(job["plan"],job["assets"],info["duration"])
    length=(end-start)/FPS
    concat=[]
    for i,(a,b,shot) in enumerate(prepared):
        filename=f"segment-{i:04}.mp4"
        emit({"progress":15+round(65*i/len(prepared)),"stage":f"Jelenet {i+1}/{len(prepared)}"})
        segment(source,job["assets"],shot,a/FPS,b-a,size,filename,directory)
        concat.append(f"file '{filename}'")
    (directory/"concat.txt").write_text("\n".join(concat)+"\n",encoding="utf8")
    cmd=[FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-f","concat","-safe","1","-i","concat.txt"]
    inputs=[]
    if info["audio"]:
        cmd+=["-ss",str(start/FPS),"-t",str(length),"-i",source]
        inputs.append(("1:a","1.0"))
    if job.get("music"):
        cmd+=["-stream_loop","-1","-i",job["music"]]
        inputs.append((f'{1+len(inputs)}:a',"0.17"))
    if options.get("clicks") and len(prepared)>1:
        clicks(length,[(a-start)/FPS for a,b,shot in prepared[1:]],directory/"clicks.wav")
        cmd+=["-i","clicks.wav"]
        inputs.append((f'{1+len(inputs)}:a',"0.6"))
    cmd+=["-map","0:v:0"]
    if inputs:
        mixers=[f"[{stream}]volume={gain},apad[a{i}]" for i,(stream,gain) in enumerate(inputs)]
        tracks="".join(f"[a{i}]" for i in range(len(inputs)))
        cmd+=["-filter_complex",";".join([*mixers,tracks+f"amix=inputs={len(inputs)}:normalize=0,alimiter=limit=.94[a]"]),
              "-map","[a]","-c:a","aac","-b:a","192k"]
    if options.get("captions") and captions(job["words"],start/FPS,end/FPS,directory/"captions.ass"):
        cmd+=["-vf","ass=captions.ass",*encoder()]
    else:
        cmd+=["-c:v","copy"]
    emit({"progress":88,"stage":"Hangkeverés és export"})
    call([*cmd,"-t",str(length),"-movflags","+faststart","result.mp4"],directory)
    output=inspect(str(directory/"result.mp4"),directory)
    if not output["width"] or abs(output["duration"]-length)>.5:
        raise ValueError("Az export hossza eltér a vágási tervtől.")
    emit({"result":output})


if __name__=="__main__":
    try:
        action=sys.argv[1]
        if action=="inspect":
            emit({"result":inspect(sys.argv[2])})
        else:
            directory=Path(sys.argv[2]).resolve()
            job=json.load(sys.stdin)
            if action=="render":render(job,directory)
            if action=="prepare":
                info=inspect(job["source"],directory)
                if info["width"]<=0 or info["duration"]<=0:raise ValueError("Adj meg érvényes videófájlt.")
                start,end=job["start"],job["end"]
                emit({"progress":15,"stage":"Képkockák elemzése"})
                span=end-start
                call([FFMPEG,"-hide_banner","-loglevel","error","-y","-ss",str(start),"-t",str(span),"-i",job["source"],
                      "-vf",f"fps=6/{span:.4f},scale=320:-2,tile=3x2:padding=4:margin=4","-frames:v","1","contact.jpg"],directory)
                if info["audio"]:
                    emit({"progress":28,"stage":"Hang előkészítése"})
                    call([FFMPEG,"-hide_banner","-loglevel","error","-y","-ss",str(start),"-t",str(span),"-i",job["source"],
                          "-vn","-ar","16000","-ac","1","-c:a","pcm_s16le","voice.wav"],directory)
                emit({"result":info})
    except (ValueError,KeyError,OSError,FileNotFoundError) as error:
        emit({"error":str(error)})
        sys.exit(1)
