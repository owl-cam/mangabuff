# MangaBuff Card Statistics

Расширение для отображения статистики карточек прямо в каталоге mangabuff.ru

## Возможности

- Показывает количество страниц владельцев карты
- Показывает количество страниц желающих получить карту
- Быстрая загрузка данных (только 2 запроса на карточку)
- Кэширует данные для быстрого повторного отображения
- Работает на страницах: `/cards`, `/users/*/cards`, `/market`, `/decks/*`, `/clubs/*/boost`, `/manga/*`, `/trades/*`

## Установка расширения

### Chrome / Edge / Яндекс.Браузер (рекомендуется)

Установите из [Chrome Web Store](https://chromewebstore.google.com/detail/gghoemgniaobdlhdobfcmdngdcegaepl).

## Установка через Tampermonkey (альтернатива для Android)

1. Установите браузер [Edge](https://play.google.com/store/apps/details?id=com.microsoft.emmx&pcampaignid=web_share)
1. Установите расширение [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
2. [Включить выполнение скриптов](https://www.tampermonkey.net/faq.php?q=Q209)
3. Установить [скрипт](https://raw.githubusercontent.com/owl-cam/mangabuff/master/mangabuff-card-stats.user.js)

## Использование

После установки расширение автоматически активируется на поддерживаемых страницах mangabuff.ru.

На каждой карточке в каталоге появится оверлей с информацией:
- **Владельцев:** количество страниц владельцев (чем меньше, тем реже карта)
- **Желают:** количество страниц желающих (чем больше, тем популярнее карта)

![Карточка](https://github.com/zamoroz/mangabuff/raw/master/media/card.png)

На странице профиля выводится число его принятых обменов.

![Профиль](https://github.com/zamoroz/mangabuff/raw/master/media/profile.png)

На торговой площадке у карточек отображаются цены на карточку.

![Лот](https://github.com/zamoroz/mangabuff/raw/master/media/lots.png)

## Структура репозитория

```
mangabuff/
├── data/                          # Archived HTML pages from mangabuff.ru
├── extension/                     # Browser extension (Chrome + Firefox)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── styles.css
├── mangabuff-card-stats.user.js   # Tampermonkey script (legacy)
└── README.md
```

## Изменения

## 2.2.0

- Настройки

### 2.1.0

- Самодостаточное браузерное расширение для Chrome и Firefox
- Хранение кэша в изолированном хранилище расширения

### 2.0.4

- Вывод инфы о карте в обменах и в истории

### 2.0.3

- В первую очередь обновляются карты без данных

### 2.0.2

- Рефакторинг
- Увеличено время жизни карт
- Устаревшие данные выводятся серым цветом
- Добавлены обновления с GitHub

### 2.0.0

- Добавлен сервис для сбора статистики, пока что только по владельцам/желающим

### 1.1.0

- Обновления внешнего вида
- Минификация скрипта
- Добавлен крестик пользователю, с которым нельзя обмениваться

### 1.0.0

- Первый релиз
