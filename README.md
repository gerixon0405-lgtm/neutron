# Neutron

Magyar nyelvű asztali alkalmazás AI-chatekhez, karakterekhez és projektekhez. [Letöltés Windowsra és Linuxra](https://github.com/gerixon0405-lgtm/neutron/releases/latest).

Windows x64-en indítsd el az EXE-telepítőt. Linux x64-en tedd futtathatóvá az AppImage fájlt, és indítsd írható helyről. A telepített alkalmazás indulás után és hatóránként ellenőrzi az új stabil kiadást. A letöltött frissítést kilépéskor telepíti.

A Beállításokban kezelheted a Codex-, Claude- és Gmail-kapcsolatokat. A Gmailhez Google-alkalmazásjelszót vagy saját, Gmail API-val engedélyezett Desktop OAuth-kliens JSON-fájlját használhatod. A chatben megadott címzettek külön levelet kapnak. A küldés állapota a Beállításokban látható.

A Codex és Claude használatához a megfelelő CLI és bejelentkezés szükséges. Linuxon a segédprogramokhoz rendszer-Python 3, requests, a Gmailhez PyGObject és a Secret Service kulcstartó szükséges. A hangfelismeréshez külön whisper modell és FFmpeg kell. A Spotify lejátszásilista-műveleteihez a helyi Spotify-híd szükséges.

Fejlesztői indítás: npm ci, majd npm start. A csomag verziójával egyező v-verziótag feltöltése elindítja a két platform buildjét és a GitHub Release közzétételét.

A chat jogosultságmenüjében a „Mappa vagy meghajtó hozzáadása…” paranccsal további könyvtárakat adhatsz a csevegéshez. Codex esetén ez szerkesztési módra vált. A menüből egyenként eltávolíthatod a hozzáadott mappákat.

Windowson a chat lekérheti a telepített illesztőprogramok verzióját, a kiadót, az aláírás állapotát és a hibás eszközöket. Megnyithatja a választható Windows-frissítéseket is. Helyi illesztőprogram telepítésekor te választod ki az INF-fájlt, majd a Windows jogosultságkérő ablakában engedélyezheted a PnPUtil futását.

A megjelenést, a nevet és a hangjelzéseket a **Beállítások → Megjelenés** alatt módosíthatod. A **Frissítések** fülön a korábbi kiadási megjegyzéseket is megnyithatod. Minden új verzióhoz vegyél fel egy bejegyzést a `releases.json` elejére. Ezt használja a kiadási folyamat és az alkalmazáson belüli újdonságablak is.

### Spotify-playlistek

A dalok eltávolítását, a listák átnevezését és a könyvtárból való eltávolításukat a **Beállítások → Kapcsolatok** alatt bekapcsolható Spotify Web API végzi. A módosítások a szokásos Spotify desktop kliensben is megjelennek. Saját alkalmazás használatakor hozz létre egy alkalmazást a [Spotify fejlesztői felületén](https://developer.spotify.com/dashboard), add hozzá a `http://127.0.0.1:47812/callback` címet, majd add meg a Client ID-t a Neutronban. A Spotify a fejlesztői módú alkalmazás tulajdonosától Premium előfizetést kér. A lejátszás meglévő helyi vezérlése külön működik.

### Magyar hang

Helyi beszédfelismeréshez a Neutron előnyben részesíti a többnyelvű Whisper large-v3-turbo Q5, large-v3-turbo és medium modelleket a small előtt. A `NEUTRON_WHISPER_BIN` és `NEUTRON_WHISPER_MODEL` változóval saját telepítés is megadható. A Piper neurális magyar felolvasó az Anna modellt a `~/.local/share/neutron/speech` mappában keresi. Egyéni futtató és hangmodell a `NEUTRON_PIPER_BIN` és `NEUTRON_PIPER_MODEL` változókkal állítható be.

A Hangasszisztens párbeszédablakban opcionálisan Azure Speech-erőforrást állíthatsz be Noémi vagy Tamás hangjával. Ilyenkor a felvétel és a felolvasandó szöveg a Microsoft Speech szolgáltatáshoz kerül. A kulcsot a Neutron a rendszer titkosításával tárolja. Az Azure-kapcsolat leválasztásakor a helyi feldolgozás áll vissza.
