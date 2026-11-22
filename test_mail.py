from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import gmail
import mail_outbox as box

class Mail(TestCase):
    def setUp(self):
        temp=self.enterContext(TemporaryDirectory())
        self.enterContext(patch.object(box,"ROOT",Path(temp)))
        secrets={}
        def vault(slot,value=None,remove=False):
            if remove: return secrets.pop(slot,None)
            if value is None: return secrets.get(slot)
            secrets[slot]=value
        self.enterContext(patch.object(gmail,"vault",side_effect=vault))
        box.connect({"email":"sender@example.org","method":"smtp"})

    def test_bulk(self):
        addresses=[f"user{i}@example.org" for i in range(250)]
        batch=box.enqueue(addresses+addresses,"Árvíztűrő","Levél","chat-1")
        self.assertEqual(batch["id"],box.enqueue(addresses[::-1],"Árvíztűrő","Levél","chat-1")["id"])
        with patch.object(gmail,"send_smtp") as transport,box.database() as db:
            while box.step(db): pass
            self.assertEqual([call.args[2]["To"].addr_spec if hasattr(call.args[2]["To"],"addr_spec") else str(call.args[2]["To"]) for call in transport.call_args_list],addresses)
        self.assertEqual(box.status(batch["id"])["counts"],{"sent":250})

    def test_pause_and_cancel(self):
        batch=box.enqueue(["x@example.org"],"X","Y","scope")
        with patch.object(gmail,"deliver",side_effect=gmail.DeliveryError("pending","quota",900)),box.database() as db:
            self.assertTrue(box.step(db))
            self.assertFalse(box.step(db))
        self.assertEqual(box.cancel(batch["id"])["counts"],{"cancelled":1})
