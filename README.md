🌱 GardenBred (MVP – Pre-Pets)

Một webgame nông trại lai tạo hạt giống, được build bằng Node.js (Express + WebSocket) và SQLite.
Phiên bản này kết thúc ở mốc MVP hoàn chỉnh cho Seed / Pot / Floor / Market, chưa triển khai tính năng Pet.

📂 Cấu trúc dự án
GBweb/
│── package.json          # cấu hình npm (dependencies, scripts)
│── server.js             # server Node.js (Express + WS + SQLite)
│── game.db               # database SQLite (runtime)
├── public/               # client-side
│   │── index.html        # giao diện game (Lobby, Farm, Shop, …)
│   │── style.css         # style (UI, plots, gacha, market…)
│   └── client.js         # logic client, kết nối API & WebSocket
│   └── assets/           # hình ảnh (Seeds, Pots,…)
│
└── tools/
    │── breed_map.json    # map lai giống class → kết quả
    │── class_weights.json# trọng số class hạt (game balance)
    │── pets_weights.json # (placeholder, chưa dùng)
    │── schema.sql        # cấu trúc bảng SQLite
    └── migrate.js        # script tạo DB từ schema

🚀 Cách chạy
1. Cài dependencies
npm install

2. Tạo database
npm run migrate


(sẽ tạo file game.db từ schema.sql)

3. Chạy server
npm run dev     # hot reload với nodemon
# hoặc
npm start       # chạy production


Server mặc định chạy tại: http://localhost:3000

🎮 Tính năng đã hoàn thành

Auth/Login (username ngắn gọn).

Shop: mua seeds (Fire, Water, Wind, Earth) + pots (Basic/Gold/TimeSkip) + traps.

Farm (Plots):

Đặt pot, trồng seed, hiển thị class + mutation.

Auto Pot / Auto Plant (có filter).

Floor system (mua thêm tầng, mỗi tầng 10 slots).

Harvest All, Plant All.

Lock plot (chống trộm).

Mutations: Green, Blue, Yellow, Pink, Red, Gold, Rainbow.

Breeding: lai hai seed mature → class mới (map trong class_weights.json).

Market: list seeds để bán, mua của người khác.

Online/Visit: xem farm người chơi khác, Steal plot (nếu chưa lock/trap).

UI/UX:

Layout responsive, HUD, tabs.

Animation (grow pulse, rainbow border, sparkle).

Master–Detail inventory, filter theo state/class/mutation.

Notifier/Toast chung.

Gacha (pull seed + pity bar).

🐾 Pet System (chưa phát triển)

File pets_weights.json + thư mục assets/Pets_Image đã được chuẩn bị.

Chưa có bảng DB hay API cho Pet.

Đây chính là mốc kết thúc dự án.

🔖 Ghi chú

Phiên bản Node: 20.x

DB: SQLite local (better-sqlite3)

Nếu deploy, cần mount volume để giữ game.db.

Tag Git khuyến nghị:

git tag -a v0.9-no-pets -m "GardenBred snapshot (pre-Pets)"
git push --tags


✦ Dự án kết thúc tại đây, trước khi thêm hệ thống Pet.
Mốc này có thể xem là MVP stable để sau này tiếp tục phát triển.