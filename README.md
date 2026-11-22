# Neutron

Magyar nyelvű asztali alkalmazás AI-chatekhez, karakterekhez és projektekhez. [Letöltés Windowsra és Linuxra](https://github.com/gerixon0405-lgtm/neutron/releases/latest).

Windows x64-en indítsd el az EXE-telepítőt. Linux x64-en tedd futtathatóvá az AppImage fájlt, és indítsd írható helyről. A telepített alkalmazás indulás után és hatóránként ellenőrzi az új stabil kiadást. A letöltött frissítést kilépéskor telepíti.

A Beállításokban kezelheted a Codex-, Claude- és Gmail-kapcsolatokat. A Gmailhez Google-alkalmazásjelszót vagy saját, Gmail API-val engedélyezett Desktop OAuth-kliens JSON-fájlját használhatod. A chatben megadott címzettek külön levelet kapnak. A küldés állapota a Beállításokban látható.

A Codex és Claude használatához a megfelelő CLI és bejelentkezés szükséges. Linuxon a segédprogramokhoz rendszer-Python 3, requests, a Gmailhez PyGObject és a Secret Service kulcstartó szükséges. A hangfelismeréshez külön whisper modell és FFmpeg kell. A Spotify lejátszásilista-műveleteihez a helyi Spotify-híd szükséges.

Fejlesztői indítás: npm ci, majd npm start. A csomag verziójával egyező v-verziótag feltöltése elindítja a két platform buildjét és a GitHub Release közzétételét.
