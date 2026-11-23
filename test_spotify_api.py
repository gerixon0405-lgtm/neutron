from unittest import TestCase
from unittest.mock import patch
import spotify_api

PID = "1234567890123456789012"
URI = "spotify:track:"+PID


class SpotifyPlaylist(TestCase):
    def test_rename_and_remove_playlist(self):
        with patch.object(spotify_api,"request") as api:
            spotify_api.edit("rename_playlist","https://open.spotify.com/playlist/"+PID+"?si=abc","Zene estére")
            api.assert_called_once_with("PUT","/playlists/"+PID,json={"name":"Zene estére"})
            api.reset_mock()
            self.assertTrue(spotify_api.edit("delete_playlist",PID)["removed_from_library"])
            api.assert_called_once_with("DELETE","/me/library",params={"uris":"spotify:playlist:"+PID})

    def test_song_found_only_in_target_playlist(self):
        with patch.object(spotify_api,"pages",return_value=[{"item":{"name":"Dal","uri":URI}}]) as pages, \
             patch.object(spotify_api,"request",return_value={"snapshot_id":"saved"}) as api:
            self.assertEqual(spotify_api.edit("remove_from_playlist",PID,"Dal")["snapshot_id"],"saved")
            pages.assert_called_once_with("/playlists/"+PID+"/items")
            api.assert_called_once_with("DELETE","/playlists/"+PID+"/items",json={"items":[{"uri":URI}]})
