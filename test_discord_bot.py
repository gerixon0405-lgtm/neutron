from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import json
import os
import discord_bot as discord

GUILD="123456789012345678"
CHANNEL="234567890123456789"
USER="345678901234567890"
BOT="456789012345678901"
MSG="567890123456789012"


class DiscordBotTests(TestCase):
    def setUp(self):
        temp=Path(self.enterContext(TemporaryDirectory()))
        self.enterContext(patch.object(discord,"ROOT",temp))
        turn=temp/"turn"
        turn.write_text("current-turn",encoding="utf-8")
        self.enterContext(patch.dict(os.environ,{"NEUTRON_MAIL_TURN":str(turn)}))
        self.enterContext(patch.object(discord,"vault",return_value={"id":BOT,"token":"fixture","name":"Neutron"}))

    def test_dm_requires_approval_and_is_not_sent_twice(self):
        def api(method,endpoint,*args,**body):
            if endpoint=="/users/"+USER: return {"username":"Címzett"}
            if endpoint=="/users/@me/channels": return {"id":CHANNEL}
            if endpoint==f"/channels/{CHANNEL}/messages": return {"id":MSG}
            raise AssertionError(endpoint)
        with patch.object(discord,"api",side_effect=api) as remote:
            action=discord.stage_message("dm",USER,"Szia! @everyone")
            again=discord.stage_message("dm",USER,"Szia! @everyone")
            self.assertEqual(action["id"],again["id"])
            self.assertTrue(all(c.args[0]=="GET" for c in remote.call_args_list))
            self.assertEqual(discord.decide(action["id"],True)["message"],MSG)
            with self.assertRaisesRegex(ValueError,"jóváhagyás"):
                discord.decide(action["id"],True)
            sends=[call for call in remote.call_args_list if call.args[:2]==("POST",f"/channels/{CHANNEL}/messages")]
            self.assertEqual(len(sends),1)
            self.assertEqual(sends[0].kwargs["json"]["allowed_mentions"],{"parse":[]})

    def test_rejected_action_never_writes_to_discord(self):
        with patch.object(discord,"api",return_value={"username":"Címzett"}) as remote:
            action=discord.stage_message("dm",USER,"Szia!")
            self.assertEqual(discord.decide(action["id"],False),{"state":"denied"})
            self.assertTrue(all(c.args[0]=="GET" for c in remote.call_args_list))

    def test_setup_keeps_an_existing_category(self):
        def api(method,endpoint,*args,**body):
            if endpoint=="/guilds/"+GUILD: return {"id":GUILD,"name":"Teszt"}
            if method=="GET" and endpoint.endswith("/roles"): return [{"name":"Tag"}]
            if method=="GET" and endpoint.endswith("/channels"):
                return [{"id":CHANNEL,"name":"Közösség","type":4,"parent_id":None}]
            if method=="POST" and endpoint.endswith("/channels"): return {"id":MSG}
            raise AssertionError(endpoint)
        layout={"roles":[{"name":"Tag","color":"#9854dd"}],"categories":[
            {"name":"Közösség","channels":[{"name":"Általános Chat","kind":"text","topic":"Téma"}]}]}
        with patch.object(discord,"api",side_effect=api) as remote:
            action=discord.stage_setup(GUILD,json.dumps(layout))
            result=discord.decide(action["id"],True)
            self.assertEqual(result["kept"],["Tag","Közösség"])
            self.assertEqual(result["created"],[{"id":MSG,"name":"általános-chat"}])
            self.assertEqual(remote.call_args.kwargs["json"]["parent_id"],CHANNEL)

    def test_read_replies_from_correct_bot_conversation(self):
        with patch.object(discord,"api",side_effect=[
             {"id":CHANNEL},[{"id":MSG,"content":"Válasz","author":{"id":USER,"username":"Anna"}}]]) as remote:
            received=discord.messages("dm",USER)
            self.assertEqual(received["messages"][0]["content"],"Válasz")
            self.assertEqual(remote.call_args.args[:2],("GET",f"/channels/{CHANNEL}/messages"))
