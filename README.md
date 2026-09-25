# WebPulpit

Pulpit w stylu Windows dla serwera Ubuntu, otwierany w przeglądarce. Nie trzeba nic instalować na komputerze, wystarczy wejść na `https://IP-serwera:8443` i się zalogować.

## Co potrafi

- **Pulpit** z ikonami, paskiem zadań, menu Start i zegarem. Okna można przesuwać, zmieniać ich rozmiar, minimalizować, maksymalizować i dociągać do krawędzi ekranu (jak w Windows).
- **Eksplorator plików**
  - **przeciągnij pliki albo całe foldery z komputera** do okna lub na pulpit, a wyślą się na serwer (z paskiem postępu, bez limitu rozmiaru),
  - pobieranie plików; folder albo kilka plików pobiera się jako ZIP. W Brave i Chrome plik można też po prostu wyciągnąć z okna na pulpit Windows,
  - przeciąganie plików między folderami i oknami (przenoszenie, a z wciśniętym Ctrl kopiowanie),
  - kopiuj, wytnij, wklej, zmiana nazwy, usuwanie, nowy folder i nowy plik,
  - menu pod prawym przyciskiem myszy i skróty: `Ctrl+C`, `Ctrl+X`, `Ctrl+V`, `Ctrl+A`, `Del`, `F2`, `F5`, `Enter`, `Backspace`,
  - zaznaczanie ramką, widok ikon i widok szczegółów, sortowanie, wyszukiwanie w folderze, ukryte pliki,
  - pakowanie do ZIP i rozpakowywanie ZIP oraz TAR.GZ, uprawnienia (chmod), miniatury zdjęć.
- **Terminal** (bash) z kolorami. `Ctrl+C` kopiuje zaznaczony tekst, `Ctrl+V` wkleja.
- **Notatnik** do edycji plików tekstowych i konfiguracji (`Ctrl+S` zapisuje).
- **Podgląd** zdjęć (strzałkami przechodzisz do następnego), filmów, muzyki i PDF.
- **Menedżer zadań** wzorowany na tym z Windows:
  - **Procesy**, grupowane po nazwie, z podświetleniem obciążenia oraz sumą procesora, pamięci i dysku w nagłówku. Pod prawym przyciskiem: zakończ, wymuś zakończenie, zakończ drzewo procesów, wstrzymaj/wznów, ustaw priorytet, otwórz lokalizację pliku, właściwości,
  - **Wydajność** z wykresami z ostatnich 60 sekund: procesor (ogólnie i każdy rdzeń), pamięć (ze strukturą), każdy dysk (czas aktywności, odczyt, zapis) i każda karta sieciowa,
  - **Użytkownicy**, czyli kto jest zalogowany i ile zużywa,
  - **Szczegóły** z pełną listą procesów (PID, czas procesora, wątki, priorytet, wiersz polecenia),
  - **Usługi** (systemd): uruchom, zatrzymaj, uruchom ponownie, logi,
  - **Autostart**: włączanie i wyłączanie usług startujących razem z serwerem,
  - **Uruchom nowe zadanie** oraz szybkość odświeżania do wyboru.
- **Asystent Claude**, czyli czat z Claude wbudowany w panel:
  - pytasz po polsku, a Claude sam sprawdza stan serwera (dyski, procesy, logi, pliki konfiguracyjne) i odpowiada,
  - polecenia i zapis plików wykonuje tylko **po Twojej zgodzie** (przyciski Zezwól / Odrzuć). W ustawieniach można to zmienić na „bez pytania” albo „tylko rozmowa”,
  - rozmowy zapisują się na serwerze, a polecenia z odpowiedzi uruchomisz jednym kliknięciem w terminalu,
  - potrzebny jest klucz API z [platform.claude.com](https://platform.claude.com/settings/keys), płatny za użycie, osobno od subskrypcji Claude. Z subskrypcją Pro/Max możesz zamiast tego kliknąć **„Otwórz Claude Code w terminalu”**.
- **Sesje**, czyli kilka komputerów na jednym koncie:
  - lista zalogowanych urządzeń z IP, przeglądarką, systemem, czasem logowania i statusem online. Urządzenia można nazwać, np. „Laptop w domu”,
  - co każda sesja **ma teraz otwarte** (okna) i jej **dziennik aktywności**: operacje na plikach, wysyłanie i pobieranie, polecenia wpisane w terminalu (hasła są ukrywane), procesy, usługi, aktualizacje, pytania do asystenta,
  - **podgląd na żywo** terminala innej sesji, tylko do odczytu. Osoba oglądana dostaje powiadomienie,
  - **wylogowanie wybranej sesji** albo wszystkich innych naraz. Tamta strona od razu przechodzi do ekranu logowania, a jej terminale są zamykane,
  - powiadomienie o każdym nowym logowaniu i licznik innych zalogowanych komputerów na pasku zadań.
- **Aktualizacje** z przyciskami „Sprawdź aktualizacje” i „Aktualizuj”:
  - aktualizacja samego WebPulpitu z GitHuba (panel restartuje się sam, a strona sama się odświeża),
  - aktualizacja pakietów Ubuntu (apt) z widocznym logiem,
  - ponowne uruchomienie serwera.
- **Ustawienia**: jasny lub ciemny motyw, tapeta, zmiana hasła.
- Działa także na telefonie: pełny pulpit z oknami, aplikacje otwierają się na cały ekran, większe przyciski, a powiadomienia nie zasłaniają ikon.

- **Konta użytkowników** (aplikacja „Użytkownicy”, tylko administrator):
  - dodawanie kont z rolą **administrator** (pełny dostęp) lub **użytkownik** (widzi tylko „Serwery gier” i przypisane mu serwery – bez terminala, plików i ustawień systemu),
  - przypisywanie użytkownikom konkretnych serwerów gier, zmiana hasła i roli, usuwanie kont,
  - logowanie tą samą stroną, każdy swoim loginem i hasłem.
- **Serwery gier** (aplikacja „Serwery gier”) – mały panel hostingowy dla Ciebie i znajomych:
  - **wyszukiwarka gier**: wpisujesz nazwę (np. „Rust”, „Palworld”, „ARK”), a panel sam podpowiada dane do instalacji – AppID serwera ze Steam, komendę startową i porty (z wbudowanego katalogu popularnych gier oraz podpowiedzi na żywo ze Steam),
  - gotowe szablony: **Valheim**, **Counter-Strike 2**, **Minecraft (Java)**, dowolna inna gra ze **Steam** (podajesz AppID) albo własne polecenie startowe,
  - automatyczna instalacja plików gry (SteamCMD dla gier ze Steam, pobieranie server.jar dla Minecrafta) z widocznym postępem,
  - **konsola na żywo** każdego serwera (możesz wpisywać komendy), start / stop / restart, autostart po restarcie serwera,
  - edycja ustawień (nazwa, port, hasło, mapa, RAM itd.) i plików konfiguracyjnych,
  - **kopie zapasowe** świata / danych jednym kliknięciem, do pobrania,
  - każdy serwer działa w osobnej sesji tmux, więc przetrwa restart panelu; pamiętaj o otwarciu portów gry w zaporze / Linode Cloud Firewall.

## Instalacja na serwerze (Linode, Ubuntu)

### 1. Połącz się z serwerem z Windows

Otwórz **PowerShell** i wpisz (zamiast `TWOJE_IP` podaj IP z panelu Linode):

```powershell
ssh root@TWOJE_IP
```

Przy pierwszym połączeniu wpisz `yes`, potem hasło roota ustawione w Linode.

### 2. Zainstaluj WebPulpit

Wklej na serwerze:

```bash
apt-get update && apt-get install -y git
git clone -b claude/linux-remote-access-browser-a02w4p https://github.com/piotrpankau/server-app-11.git webpulpit
cd webpulpit
sudo bash install.sh
```

Instalator zapyta o:

- **użytkownika Linux**, jako który działa panel (domyślnie `root`, czyli pełny dostęp do wszystkich plików),
- **port** (domyślnie `8443`),
- **login i hasło** do panelu. Wymyśl mocne hasło, bo panel daje pełny dostęp do serwera.

Na końcu wypisze adres, np. `https://172.105.xx.xx:8443`.

### 3. Otwórz w przeglądarce

Wejdź na podany adres w Brave. Pojawi się ostrzeżenie o certyfikacie, bo certyfikat jest samopodpisany. Kliknij **Zaawansowane**, a potem **Przejdź do strony**. Połączenie i tak jest szyfrowane.

> **Nie otwiera się?** Jeśli serwer ma w Linode przypisany *Cloud Firewall*, dodaj w panelu (**Firewalls → Rules → Inbound**) regułę: TCP, port `8443`, Accept.

### Alternatywa: WinSCP zamiast git

1. Na stronie repozytorium kliknij **Code → Download ZIP** i rozpakuj plik.
2. W WinSCP skopiuj folder na serwer, np. do `/root/webpulpit`.
3. W PowerShell (`ssh root@TWOJE_IP`) wpisz: `cd /root/webpulpit && sudo bash install.sh`.

## Obsługa

| Co | Polecenie na serwerze |
| --- | --- |
| Stan usługi | `systemctl status webpulpit` |
| Logi na żywo | `journalctl -u webpulpit -f` |
| Restart | `systemctl restart webpulpit` |
| Zmiana loginu i hasła | `sudo bash /opt/webpulpit/install.sh --reset-password` |
| Aktualizacja | w panelu: **Start → Aktualizacje → Aktualizuj**, albo ręcznie `cd ~/webpulpit && git pull && sudo bash install.sh` |
| Odinstalowanie | `sudo bash /opt/webpulpit/install.sh --uninstall` |

Aplikacja instaluje się do `/opt/webpulpit` i startuje sama po restarcie serwera (usługa systemd `webpulpit`). Konfiguracja jest w `/opt/webpulpit/config.json`.

## Bezpieczeństwo

- Logowanie hasłem, które jest zapisane jako skrót scrypt, nigdy otwartym tekstem.
- Sesja w ciasteczku `HttpOnly`, `Secure` i `SameSite=Strict`. Po zmianie hasła wszystkie sesje są wylogowywane.
- Po 5 błędnych próbach logowania adres IP jest blokowany na 5 minut.
- Ochrona przed CSRF i przed przejęciem terminala z innej strony (sprawdzanie `Origin`).
- Domyślnie HTTPS.

Panel daje pełny dostęp do serwera (terminal i pliki), dlatego:

- ustaw długie, unikalne hasło,
- jeśli masz stałe IP w domu, możesz w Linode Cloud Firewall wpuszczać port 8443 tylko z tego adresu,
- zamiast `root` możesz podać zwykłego użytkownika. Wtedy panel widzi tylko to, do czego ten użytkownik ma prawa.

Opcja `rootDir` w `config.json` ogranicza **eksplorator plików** do jednego katalogu, np. `"/var/www"`. Terminal dalej ma dostęp do całego systemu na prawach wybranego użytkownika.

## Ręczne uruchomienie (bez instalatora)

```bash
npm install
node scripts/setup.js      # zapyta o login i hasło, zapisze config.json
node server.js
```

Bez certyfikatu w `config.json` serwer działa po zwykłym HTTP.

## Wymagania

Ubuntu 20.04 lub nowsze (albo Debian). Instalator sam doinstaluje Node.js 22 i potrzebne pakiety.
