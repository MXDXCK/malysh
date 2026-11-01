# Тесты синхронизации

Поддельный Firestore (`fakefb/firestore.js`) + облако на Python, несколько «телефонов» с раздельной памятью.
Подделка повторяет важные особенности настоящего Firestore: время сервера у записей, выпадение документа
из запроса `where('t','>',…)` пока локальная правка не подтверждена (`removed` + `hasPendingWrites`),
обрывы связи и «зависшее» подключение.

Запуск (нужны Python Playwright и Chromium; сайт отдаётся локально на :8765):

```
python3 -m http.server 8765 &
python3 tests/synctest.py tests     # основной сценарий: 2–3 телефона, правки, удаления, таймер, экономия чтений
python3 tests/pendingtest.py tests  # правки, пока предыдущая ещё летит в облако
python3 tests/profiletest.py tests  # профиль малыша и настройки
python3 tests/resilience.py tests   # зависание, обрыв связи, перезапуск
```
