from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch
import importlib
import sys
import zipfile

import web_results


class Outputs(TestCase):
    def test_shop_card_uses_visible_price(self):
        parser=web_results.Offers("https://www.shopmania.hu/q-test")
        parser.feed('<li class="prod-item" id="p-2"><img class="prod-item-img" data-src="https://example.org/img.jpg"><span class="prod-item-name">Példa</span><span class="prod-price">9&nbsp;990 Ft</span></li>')
        self.assertEqual(parser.rows[0]["price"],"9 990 Ft")
        self.assertTrue(parser.rows[0]["url"].endswith("#p-2"))

    def test_collect_completed_file_and_build(self):
        with TemporaryDirectory() as tmp:
            base=Path(tmp)
            artifacts=base/"artifacts"
            with patch.object(sys,"argv",["neutron_tools.py",str(artifacts),tmp]):
                n=importlib.import_module("neutron_tools")
                with patch.object(n,"ROOT",artifacts),patch.dict(n.os.environ,{"NEUTRON_WORKDIR":tmp}):
                    (base/"hello.txt").write_text("árvíztűrő")
                    (base/"dist").mkdir()
                    (base/"dist/index.html").write_text("<main>Próba</main>")
                    names=n.collect_outputs({"started":0,"paths":["hello.txt","../outside.txt"],"build":True})
                    self.assertEqual((artifacts/names[0]).read_text(),"árvíztűrő")
                    with zipfile.ZipFile(artifacts/names[1]) as z:
                        self.assertEqual(z.namelist(),["index.html"])


if __name__=="__main__":
    main()
