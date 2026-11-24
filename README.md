# Протоколист Google Meet

Навык Codex находит встречи по датам, названию или участникам и готовит сводку по готовым расшифровкам Google Drive. Существенные пункты сопровождаются таймкодами.

## Запуск

Нужны Windows, Node.js 22+ и Google Chrome. Из корня репозитория установите зависимости навыка.

```powershell
npm ci --prefix .agents/skills/google-meet-protocolist --omit=dev --ignore-scripts
```

Откройте репозиторий в Codex и вызовите `$google-meet-protocolist`. Пример запроса — «Найди встречи Business Booster Platform за прошлую календарную неделю и выпиши решения и поручения с таймкодами».

При первом входе или после истечения Google-сессии клиент открывает отдельное окно Chrome. После подтверждения входа он закрывает окно и делает запросы к Calendar и Drive напрямую. Сессия хранится локально в зашифрованном виде с помощью Windows DPAPI.

Инструкции для агента лежат в [SKILL.md](.agents/skills/google-meet-protocolist/SKILL.md). Команды и источники данных описаны в [справке навыка](.agents/skills/google-meet-protocolist/references/google-sources.md). [Спецификация](<Спецификация протоколиста Google Meet.md>) описывает предложенный облачный вариант.
