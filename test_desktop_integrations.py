import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch
import zipfile

import neutron_music
import prism_instances as prism


class DesktopTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.p = self.root/"instances"/"test"
        self.g = self.p/"minecraft"
        (self.g/"mods").mkdir(parents=True)
        (self.g/"logs").mkdir()
        (self.p/"instance.cfg").write_text("[General]\nname=Original\nUnrelated=keep\n")
        (self.p/"mmc-pack.json").write_text(json.dumps({"components":[{"uid":"net.minecraft","version":"1.21.1"}]}))
        self.enterContext(patch.object(prism,"data_root",return_value=self.root))
        self.procs = self.enterContext(patch.object(prism,"processes",return_value={}))

    def test_crash_then_fresh_launch(self):
        log = prism.current_log(self.p)
        log.write_text("[main/FATAL] Incompatible mods found\nMissing dependency: mod-x\n")
        (self.g/"crash-reports").mkdir()
        old = self.g/"crash-reports/crash-old.txt"
        old.write_text("Caused by: OldFailure")
        os.utime(old,(time.time()-20,time.time()-20))
        rec = {"time":time.time(),"log":prism.signature(log),"prefix":prism.prefix_hash(log),"pending":True}
        (self.p/".neutron-launch.json").write_text(json.dumps(rec))
        self.assertEqual(prism.status(self.p)["state"],"waiting_for_game")
        with log.open("a") as f:
            f.write("[main/FATAL] Incompatible mods found\nCaused by: NewFailure\n")
        self.assertEqual(prism.status(self.p)["state"],"exited_with_errors")
        detail = prism.run(self.p,"diagnose")
        self.assertIsNone(detail["crash_report"])
        self.assertIn("Caused by: NewFailure",detail["diagnostic_lines"])
        self.assertNotIn("Caused by: OldFailure",detail["diagnostic_lines"])
        self.assertTrue(detail["suggestions"])

    def test_edits_and_game_identity(self):
        prism.edit(self.p,"memory","3072")
        self.assertIn("Unrelated=keep",(self.p/"instance.cfg").read_text())
        self.assertIn("name=Original",(self.p/"instance.cfg.neutron-backup").read_text())
        mods = self.g/"mods"
        with zipfile.ZipFile(mods/"example.jar","w") as z:
            z.writestr("fabric.mod.json",'{"id":"example"}')
        self.assertFalse(prism.toggle(self.p,"example.jar",False)["enabled"])
        self.assertTrue(prism.toggle(self.p,"example.jar.disabled",True)["enabled"])
        self.procs.return_value={self.g:[999999]}
        with self.assertRaisesRegex(ValueError,"fut"):
            prism.toggle(self.p,"example.jar",False)
        self.assertTrue(prism.list_instances()[0]["running"])
        with self.assertRaises(ValueError):
            prism.instance("../outside")

    def test_playlist_commands(self):
        with patch.object(neutron_music,"launch"), patch.object(neutron_music,"bridge",return_value="ok") as bridge:
            self.assertEqual(neutron_music.local("create_playlist","Este"),"ok")
            bridge.assert_called_with({"action":"create_playlist","name":"Este","query":""})
            neutron_music.local("add_to_playlist","Este","Example Song")
            bridge.assert_called_with({"action":"add_to_playlist","name":"Este","query":"Example Song"})
            neutron_music.local("play_song","Example Song")
            bridge.assert_called_with({"action":"play","query":"Example Song"})


if __name__ == "__main__":
    unittest.main()
