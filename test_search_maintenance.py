import importlib
import json
import os
import sys
import unittest
from unittest.mock import Mock, patch
import requests
import pc_maintenance


def response(text="", payload=None):
    return Mock(text=text,json=Mock(return_value=payload))


class SearchAndMaintenance(unittest.TestCase):
    def setUp(self):
        with patch.object(sys,"argv",["neutron_tools.py","artifacts"]):
            self.tools=importlib.import_module("neutron_tools")

    def test_excluded_source_and_duplicates(self):
        html="".join(f'<a class="result-link" href="https://{host}/spec">MSI</a>'
                     for host in ("us.msi.com","www.us.msi.com","example.org","example.org"))
        with patch.object(requests,"get",return_value=response(html)) as get:
            rows=self.tools.ddg_search("MSI motherboard","us.msi.com")
        self.assertEqual([r["url"] for r in rows],["https://example.org/spec"])
        self.assertEqual("MSI motherboard",get.call_args.kwargs["params"]["q"])

    def test_independent_index_after_rejections(self):
        page={"title":"Budapest","fullurl":"https://hu.wikipedia.org/wiki/Budapest","extract":"Város"}
        with patch.object(requests,"get",side_effect=[requests.HTTPError("403"),response("challenge"),requests.HTTPError("503"),
                response(payload={"query":{"pages":{"1":page}}})]):
            self.assertEqual(self.tools.ddg_search("Budapest")[0]["snippet"],"Város")

    def test_mcp_action_dispatch(self):
        for action in ("inspect","optimize","status"):
            with patch.object(pc_maintenance,"maintain",return_value={"state":"Running"}) as handler:
                reply=self.tools.dispatch({"method":"tools/call","params":{"name":"windows_maintenance","arguments":{"action":action}}})
                handler.assert_called_once_with(action)
                self.assertEqual(json.loads(reply["content"][0]["text"])["state"],"Running")

    def test_status_cannot_start_task(self):
        with patch.dict(os.environ,{"SystemRoot":"C:/Windows"}),patch("subprocess.run",return_value=Mock(returncode=0,stdout='{"state":"Ready"}')) as run:
            pc_maintenance.task()
            self.assertNotIn("Start-ScheduledTask",run.call_args.args[0][-1])
            pc_maintenance.task(True)
            self.assertIn("Start-ScheduledTask",run.call_args.args[0][-1])

    @unittest.skipUnless(os.name=="nt","Windows metrics")
    def test_native_measurement(self):
        measured=pc_maintenance.maintain("inspect")
        self.assertGreater(measured["system_drive_total_bytes"],0)
        self.assertIn("memory_percent",measured)
