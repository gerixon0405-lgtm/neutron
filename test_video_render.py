from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import video_render as video


@unittest.skipUnless(video.FFMPEG and video.FFPROBE,"FFmpeg and ffprobe")
class VideoRender(unittest.TestCase):
    def test_render_timed_mp4_with_broll_and_captions(self):
        with TemporaryDirectory() as temp:
            directory=Path(temp)
            src=str(directory/"felvétel.mp4")
            still=str(directory/"cutaway.png")
            video.call([video.FFMPEG,"-v","error","-y","-f","lavfi","-i","color=blue:size=256x144:rate=30",
                        "-f","lavfi","-i","sine=frequency=380:sample_rate=16000","-t","3","-threads","2",
                        *video.encoder(),"-pix_fmt","yuv420p","-c:a","aac",src])
            video.call([video.FFMPEG,"-v","error","-y","-f","lavfi","-i","color=orange:size=256x144",
                        "-frames:v","1","-threads","1",still])
            job={"source":src,"assets":{"picture":still},"options":{"format":"16:9","quality":"720","captions":True,"clicks":True},
                 "plan":{"start":0,"end":2.5,"shots":[{"at":.4,"len":.8,"asset":"picture","device":"tile","grade":"amber"},
                                                       {"at":1.5,"len":.7,"device":"punch"}]},
                 "words":[{"start":.4,"end":.9,"text":"Árvíztűrő"}]}
            video.render(job,directory)
            result=video.inspect(str(directory/"result.mp4"))
            self.assertEqual((result["width"],result["height"]),(1280,720))
            self.assertTrue(result["audio"])
            self.assertAlmostEqual(result["duration"],2.5,delta=.14)

    def test_overlap_and_disabled_asset_use_camera(self):
        shots=[{"at":0,"len":2,"device":"cut","asset":"bad"},
               {"at":1,"len":2,"device":"punch"}]
        self.assertEqual(video.scenes({"start":0,"end":3,"shots":shots},{},3)[2],
                         [(0,60,{}),(60,90,shots[1])])
