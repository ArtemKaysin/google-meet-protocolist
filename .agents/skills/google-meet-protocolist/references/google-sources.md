# Источники Google для протоколиста

## Проверка сессии перед запуском

Возьми ожидаемый email из запроса или настроек Google-подключения пользователя. Используй [локальный HTTP-клиент](../scripts/google-meet-http.mjs). Нужны Windows, Node.js 22+ и установленный Chrome. Если зависимости ещё не установлены, агент выполняет `npm ci --omit=dev --ignore-scripts` из каталога навыка.

Запускай команду с полным путём к скрипту и `--account EMAIL`. `status` проверяет сессию в самостоятельном HTTP-контексте и возвращает `session_ready` или состояние ошибки. Если нужен вход, сразу запускай `login` либо нужную рабочую команду. Клиент открывает видимое окно Chrome и сообщает `browser_opened` в stderr. Попроси пользователя подтвердить вход в открывшемся окне и дождись завершения процесса. Клиент закрывает своё окно, проверяет сессию самостоятельным HTTP-запросом и сохраняет её только при успешной проверке.

Cookies для Google Calendar, Drive и входа Google хранятся локально в `%LOCALAPPDATA%\GoogleMeetProtocolist` и зашифрованы Windows DPAPI для текущего пользователя Windows. Клиент загружает их в память самостоятельного HTTP-контекста. При новом запуске проверяется аккаунт и доступ к Drive. [Самостоятельный HTTP-контекст Playwright](https://playwright.dev/docs/api/class-apirequest#api-request-new-context) · [Windows DPAPI](https://learn.microsoft.com/dotnet/api/system.security.cryptography.protecteddata)

`session_required` означает, что нужен вход, `account_mismatch` — что в сессии другой основной Google-аккаунт. При `session_unverified` проверь ошибку доступа или сети. `standalone_session_unverified` означает, что Google не подтвердил сессию в самостоятельном клиенте после закрытия окна. Если пользователь закрыл окно входа или истекло время ожидания, клиент сообщает `login_cancelled` или `login_timed_out`.

## Календарь и записи

Начни с команды `list` [локального HTTP-клиента](../scripts/google-meet-http.mjs). Подставь даты и варианты названия серии:

```text
node <skill-folder>/scripts/google-meet-http.mjs list --account <email> --from 2026-11-16T00:00:00+03:00 --to 2026-11-23T00:00:00+03:00 --time-zone Europe/Moscow --query "Daily BB Platform" --query "Business Booster Platform"
```

Передай `--from` и `--to` в RFC 3339 с явным смещением. Верхняя граница исключается. `--time-zone` задаёт часовой пояс пользователя. `--query` фильтрует название и проверяет календари с точным совпадением названия. `--person` фильтрует по email участника или организатора. `--calendar` добавляет конкретные календари по названию или ID. Эти три параметра можно повторять.

Клиент читает данные недельной страницы Calendar (`GET /calendar/u/0/r/week/YYYY/MM/DD`) и повестку (`GET /calendar/u/0/htmlembed`). Недельная страница даёт выбранные календари, ссылки Meet, участников и видеовложения. Повестка даёт экземпляры повторяющихся событий, у которых ещё нет отдельной записи в недельных данных. Используй `meetings` и проверь `checkedCalendars`. При `partial` смотри `issues` и дочитай недостающие данные через коннектор или прямой пользовательский OAuth того же аккаунта. Форматы веб-ответов могут меняться.

Если видеовложения нет, найди запись через Meet API по коду и времени экземпляра или через поиск файлов Drive по названию и дате. Для этих операций используй коннектор с подтверждённым аккаунтом пользователя или прямой пользовательский OAuth. Cookies в проверке открыли веб-страницы и субтитры, а публичные API потребовали отдельную авторизацию. У чужого организатора и для старых встреч список Meet может быть неполным. [Google Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) · [Конференции Meet](https://developers.google.com/workspace/meet/api/guides/conferences) · [Записи Meet](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.recordings)

В комплекте есть помощник `scripts/google-meet.mjs` для Node.js 22+. Запускай нужную команду с полным путём к файлу. Для всех команд передавай `--from` и `--to` в RFC 3339 с часовым поясом. `--to` задаёт исключительную границу.

| Команда | Параметры и назначение |
| --- | --- |
| `list` | `--query` фильтрует название. Повторяй флаг для вариантов названия. `--person` ищет участников по имени или email. По умолчанию читается основной календарь. `--calendar ID` выбирает конкретные календари, `--visible-calendars` добавляет выбранные в Google Calendar. |
| `recordings` | `--meet-code` принимает код из ссылки. Передай интервал около даты конкретного экземпляра с запасом на задержку старта. Выбирай доступные части со статусом `FILE_GENERATED`. |
| `drive` | Запасной поиск записей одного аккаунта. Передай начало названия через `--query` и короткий интервал создания файла, охватывающий день встречи и время обработки. Сопоставь дату и название перед чтением дорожки. |

Для прямых запросов передай `--account` с тем же email, который прошёл проверку сессии. `--oauth-stdin` принимает `{"access_token":"..."}` от поставщика прямой пользовательской авторизации Google через канал в памяти. Передавай результат поставщика сразу в stdin помощника. Токен остаётся вне аргументов команды, ответов и сохранённых файлов. Помощник сверяет подтверждённый email из Google UserInfo перед обращением к данным. Для этого токену нужен доступ к email (`openid email` или `userinfo.email`). Для Calendar используй `calendar.events.readonly` и, при проверке выбранных календарей, `calendar.calendarlist.readonly`. Для Meet используй `meetings.space.readonly`, для записей Drive подходит `drive.meet.readonly`. [Google UserInfo](https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation) · [Разрешения Calendar](https://developers.google.com/workspace/calendar/api/auth) · [Разрешения Meet](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)

Пример команды после подключения пользовательского OAuth и проверки браузерной сессии. Подставь даты нужного периода.

```text
<поставщик пользовательского токена> | node <skill-folder>/scripts/google-meet.mjs list --oauth-stdin --account <email> --from 2026-11-16T00:00:00+03:00 --to 2026-11-23T00:00:00+03:00 --query "Business Booster Platform" --query "Бизнес Бустер Платформ"
```

## Готовая дорожка Drive

Дорожка панели Drive проверена на русских записях. В авторизованной сессии HTTP-запрос к `https://drive.google.com/timedtext` с параметрами `id`, `type=track`, `lang=ru`, `kind=asr`, `fmt=json3`, `xospf=1` возвращает текст и таймкоды. `xospf=1` сохраняет маркеры смены говорящего. Токены `drive.meet.readonly` и `drive.readonly` из проверенного Cloud-проекта не дали доступа к этому внутреннему сервису. Авторизация Calendar и чтение метаданных Drive сами по себе не подтверждают доступ к дорожке.

Для каждого подтверждённого Drive ID используй `captions --account EMAIL --file-id ID` у [локального клиента](../scripts/google-meet-http.mjs). Команда возвращает всю дорожку за один запрос. Повторяй `--file-id`, чтобы прочитать несколько записей за один запуск. Если полный текст превышает лимит вывода, передай `--limit` и продолжай с `--offset`, взяв его из `nextOffset`.

Чтобы проверить название и доступность файла по известному ID, используй `metadata --account EMAIL --file-id ID`. Клиент читает метаданные страницы Drive прямым `GET /file/d/{id}/view`.

Для уже сверенной записи с действующей подписанной ссылкой `timedTextBaseUrl` можно дополнительно проверить дорожку прямым запросом к Drive. Передавай параметры подписи только исходному адресу Google Drive и его редиректам к `timedtext` на том же хосте. Используй ссылку только в запросе.

`ready` возвращает версию, число фрагментов и запрошенную часть. Дочитай через `nextOffset` до `null`, проверяя одну версию. При ошибке сессии останови выполнение. `unavailable` означает, что Google не отдал дорожку. `no_text` означает, что ожидаемая дорожка пока не вернула содержимое. Для свежей записи её можно проверить позднее.

Если подходит отдельная расшифровка Meet, `conferenceRecords.transcripts.entries` доступен для поддерживаемых языков и отдаёт время и ссылки на участников. Реплики доступны через API 30 дней. В опубликованном списке языков Meet Transcripts русского нет. Автосубтитры Drive поддерживают русский. [Артефакты Meet](https://developers.google.com/workspace/meet/api/guides/artifacts) · [Языки Meet Transcripts](https://support.google.com/meet/answer/12849897?hl=en) · [Субтитры Drive](https://support.google.com/drive/answer/1372218?hl=ru)
