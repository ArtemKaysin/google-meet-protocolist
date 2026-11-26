# Протоколист Google Meet

Навык Codex находит встречи по датам, названию или участникам, а также видео Google Drive по названию, папке или ссылке. Сводка по готовой дорожке содержит таймкоды.

## Запуск

Нужны Windows или macOS, Node.js 22+ и Google Chrome. Из корня репозитория установите зависимости навыка:

```sh
npm ci --prefix .agents/skills/google-meet-protocolist --omit=dev --ignore-scripts
```

На macOS нужны также Xcode Command Line Tools (если их нет, запустите `xcode-select --install`). Затем один раз соберите помощник для Связки ключей:

```sh
npm run --prefix .agents/skills/google-meet-protocolist setup:macos
```

Откройте репозиторий в Codex и вызовите `$google-meet-protocolist`. Пример запроса — «Найди встречи Business Booster Platform за прошлую календарную неделю и выпиши решения и поручения с таймкодами».

При первом входе или после истечения Google-сессии клиент открывает отдельное окно Chrome. Войдите в свой Google-аккаунт. После проверки клиент закрывает окно и обращается к Calendar и Drive напрямую. На Windows сессия защищена Windows DPAPI; на macOS она хранится в локальной Связке ключей отдельно для каждого Google-аккаунта. Переносить сессию с другого компьютера или создавать OAuth-приложение не нужно.

Для проверки установки на Mac выполните `npm test --prefix .agents/skills/google-meet-protocolist`. Тесты не требуют входа в Google.

Инструкции для агента лежат в [SKILL.md](.agents/skills/google-meet-protocolist/SKILL.md). Команды и источники данных описаны в [справке навыка](.agents/skills/google-meet-protocolist/references/google-sources.md). [Спецификация](<Спецификация протоколиста Google Meet.md>) описывает предложенный облачный вариант.
