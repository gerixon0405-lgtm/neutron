import os
from datetime import timedelta

async def control(action,value):
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
    from winrt.windows.media import MediaPlaybackAutoRepeatMode
    from neutron_music import uri
    if action=="open":
        os.startfile(uri(value))
        return "Átadva a Spotifynak."
    manager=await GlobalSystemMediaTransportControlsSessionManager.request_async()
    session=next((s for s in manager.get_sessions() if "spotify" in s.source_app_user_model_id.lower()),None)
    if not session:
        raise ValueError("A Spotify nem adott át médialejátszási munkamenetet. Indíts el benne egy dalt.")
    if action=="status":
        m=await session.try_get_media_properties_async()
        return {"status":session.get_playback_info().playback_status.name.title(),"track":m.title,"artist":[m.artist],"album":m.album_title}
    if action=="volume":
        from pycaw.pycaw import AudioUtilities
        vol=float(value)
        if not 0<=vol<=100: raise ValueError("A hangerő 0 és 100 közötti szám.")
        targets=[s for s in AudioUtilities.GetAllSessions() if s.Process and s.Process.name().lower()=="spotify.exe"]
        if not targets: raise ValueError("Nem található aktív Spotify-hangkimenet.")
        for s in targets: s.SimpleAudioVolume.SetMasterVolume(vol/100,None)
        return "Hangerő beállítva."
    if action=="seek": ok=await session.try_change_playback_position_async(max(0,int(float(value)*10_000_000)))
    elif action=="shuffle" and value in ("on","off"): ok=await session.try_change_shuffle_active_async(value=="on")
    elif action=="repeat" and value in ("None","Track","Playlist"):
        ok=await session.try_change_auto_repeat_mode_async(getattr(MediaPlaybackAutoRepeatMode,{"None":"NONE","Track":"TRACK","Playlist":"LIST"}[value]))
    else:
        name={"play":"play","pause":"pause","toggle":"toggle_play_pause","next":"skip_next","previous":"skip_previous","stop":"stop"}.get(action)
        if not name:raise ValueError("Ismeretlen lejátszási művelet.")
        ok=await getattr(session,"try_"+name+"_async")()
    if not ok:raise ValueError("A Spotify elutasította a műveletet.")
    return "Végrehajtva."
