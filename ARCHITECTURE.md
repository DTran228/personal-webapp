# Personal Finance Tracker with Market Data — Kiến trúc chi tiết

> Project 1 trong lộ trình: React + Node.js + PostgreSQL + Redis + Finnhub API.
> Mục tiêu: một app theo dõi danh mục đầu tư cá nhân, có giá cổ phiếu real-time,
> caching thông minh, và dashboard lãi/lỗ.

## 1. Tổng quan hệ thống

```
┌──────────┐      REST API       ┌─────────────┐        ┌──────────────┐
│  React   │ ◄─────────────────► │   Node.js   │ ◄────► │  PostgreSQL  │
│  (Vite)  │                     │  (Express)  │        │ (dữ liệu user│
└──────────┘                     └──────┬──────┘        │  & giao dịch)│
                                        │               └──────────────┘
                                 cache  │  miss
                                        ▼
                                 ┌─────────────┐        ┌──────────────┐
                                 │    Redis    │  miss  │ Finnhub API  │
                                 │ (cache giá) │ ─────► │ (market data)│
                                 └─────────────┘        └──────────────┘
```

**Nguyên tắc cốt lõi:** Client KHÔNG BAO GIỜ gọi Finnhub trực tiếp.
Mọi request giá đi qua backend → backend check Redis trước → miss thì mới gọi
Finnhub → lưu vào Redis với TTL 30 giây. Đây chính là câu chuyện
"giảm 80% API calls" để kể với recruiter.

## 2. Tech stack & lý do chọn

| Layer | Công nghệ | Lý do (để trả lời phỏng vấn) |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript | Vite dev server nhanh, TS bắt lỗi sớm |
| UI | TailwindCSS + Recharts | Nhanh, không cần design skill; Recharts vẽ chart portfolio |
| Backend | Node.js + Express + TypeScript | Đơn giản, phổ biến, dễ giải thích |
| Database | PostgreSQL | Dữ liệu giao dịch cần tính toàn vẹn (ACID) — đúng ngôn ngữ finance |
| Cache | Redis (ioredis) | Finnhub free tier chỉ 60 calls/phút → cache TTL 30s |
| Market data | Finnhub API (free tier) | Có quote real-time, company profile, miễn phí |
| Auth | JWT (access + refresh token) | Chuẩn công nghiệp, dễ demo |

## 3. Database schema (PostgreSQL)

```sql
-- Người dùng
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,          -- bcrypt
    display_name  VARCHAR(100),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Danh mục đầu tư (1 user có thể có nhiều portfolio: "Dài hạn", "Lướt sóng"...)
CREATE TABLE portfolios (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Giao dịch mua/bán — đây là source of truth, KHÔNG lưu "số lượng hiện tại"
-- mà tính ra từ lịch sử giao dịch (điểm cộng khi phỏng vấn: event-sourcing mindset)
CREATE TABLE transactions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol       VARCHAR(10) NOT NULL,            -- 'AAPL', 'MSFT'
    side         VARCHAR(4)  NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity     NUMERIC(18, 8) NOT NULL CHECK (quantity > 0),
    price        NUMERIC(18, 4) NOT NULL CHECK (price >= 0),  -- giá tại thời điểm giao dịch
    executed_at  TIMESTAMPTZ NOT NULL,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_portfolio ON transactions(portfolio_id, symbol);

-- Watchlist — theo dõi mã chưa mua
CREATE TABLE watchlist_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, symbol)
);

-- Refresh tokens (cho phép revoke khi logout)
CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
```

**Điểm nhấn khi phỏng vấn:**
- Dùng `NUMERIC` chứ không dùng `FLOAT` cho tiền — floating point gây sai số,
  finance không chấp nhận được.
- Không lưu "holdings" trực tiếp; số lượng nắm giữ = SUM(BUY) − SUM(SELL) tính
  từ `transactions`. Không bao giờ lệch dữ liệu.

## 4. Luồng xử lý chính

### 4.1. Lấy giá cổ phiếu (cache-aside pattern)

```
GET /api/quotes/AAPL
  1. Check Redis key `quote:AAPL`
     ├── HIT  → trả về ngay (~1ms)
     └── MISS → gọi Finnhub /quote?symbol=AAPL
                → SET quote:AAPL {json} EX 30   (TTL 30 giây)
                → trả về (~200ms)
```

- Lấy giá nhiều mã (portfolio 10 mã): endpoint `POST /api/quotes/batch`
  nhận mảng symbols, dùng Redis `MGET`, chỉ gọi Finnhub cho các mã miss.
- Nếu Finnhub lỗi/hết quota: trả về giá cache cũ (stale) kèm cờ `isStale: true`
  thay vì lỗi trắng — recruiter finance rất thích chi tiết graceful degradation này.

### 4.2. Tính lãi/lỗ portfolio

```
GET /api/portfolios/:id/summary
  1. Query transactions → gom theo symbol → tính:
     - quantity  = Σ BUY qty − Σ SELL qty
     - costBasis = trung bình giá vốn (average cost method)
  2. Lấy giá hiện tại của các symbols (qua luồng 4.1)
  3. Tính: marketValue, unrealizedPnL = (giá hiện tại − giá vốn) × quantity,
     pnLPercent
  4. Trả về summary cho dashboard
```

### 4.3. Auth flow

```
POST /api/auth/register  → bcrypt hash password → tạo user
POST /api/auth/login     → verify → trả accessToken (15 phút, JWT)
                           + refreshToken (7 ngày, httpOnly cookie)
POST /api/auth/refresh   → verify refresh token trong DB → cấp access mới
POST /api/auth/logout    → revoke refresh token
```

## 5. API endpoints

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/auth/register` | Đăng ký |
| POST | `/api/auth/login` | Đăng nhập |
| POST | `/api/auth/refresh` | Làm mới access token |
| POST | `/api/auth/logout` | Đăng xuất |
| GET | `/api/portfolios` | Danh sách portfolio của user |
| POST | `/api/portfolios` | Tạo portfolio |
| GET | `/api/portfolios/:id/summary` | Tổng quan lãi/lỗ (luồng 4.2) |
| GET | `/api/portfolios/:id/transactions` | Lịch sử giao dịch (phân trang) |
| POST | `/api/portfolios/:id/transactions` | Thêm giao dịch mua/bán |
| DELETE | `/api/transactions/:id` | Xóa giao dịch |
| GET | `/api/quotes/:symbol` | Giá 1 mã (cached) |
| POST | `/api/quotes/batch` | Giá nhiều mã |
| GET | `/api/search?q=app` | Tìm mã cổ phiếu (Finnhub symbol lookup, cache 1 ngày) |
| GET/POST/DELETE | `/api/watchlist` | Quản lý watchlist |

## 6. Cấu trúc thư mục (monorepo đơn giản)

```
personal-webapp/
├── ARCHITECTURE.md
├── docker-compose.yml          # Postgres + Redis cho dev
├── client/                     # React + Vite
│   ├── src/
│   │   ├── api/                # axios client, react-query hooks
│   │   ├── components/         # UI components tái sử dụng
│   │   ├── features/
│   │   │   ├── auth/           # login/register forms, auth context
│   │   │   ├── portfolio/      # dashboard, holdings table, PnL chart
│   │   │   ├── transactions/   # form thêm giao dịch, bảng lịch sử
│   │   │   └── watchlist/
│   │   ├── pages/              # route-level components
│   │   └── main.tsx
│   └── package.json
└── server/                     # Node.js + Express
    ├── src/
    │   ├── config/             # env vars, hằng số (TTL, rate limits)
    │   ├── db/
    │   │   ├── migrations/     # SQL migrations (node-pg-migrate)
    │   │   └── pool.ts         # pg connection pool
    │   ├── middleware/          # auth (verify JWT), error handler, rate limiter
    │   ├── modules/
    │   │   ├── auth/           # routes + service + repository
    │   │   ├── portfolios/
    │   │   ├── transactions/
    │   │   ├── quotes/         # cache-aside logic + Finnhub client
    │   │   └── watchlist/
    │   ├── lib/
    │   │   ├── redis.ts        # ioredis client
    │   │   └── finnhub.ts      # HTTP client + rate-limit guard
    │   └── index.ts
    ├── tests/                  # vitest — ưu tiên test PnL calculation
    └── package.json
```

Mỗi module theo pattern **routes → service → repository**:
- `routes.ts` — định nghĩa endpoint, validate input (zod)
- `service.ts` — business logic (tính PnL, cache logic)
- `repository.ts` — SQL queries

Đây là separation dễ giải thích nhất khi được hỏi "cấu trúc code của em thế nào?".

## 7. docker-compose cho môi trường dev

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: finance_tracker
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  pgdata:
```

## 8. Roadmap xây dựng (theo milestone, mỗi milestone chạy được)

| # | Milestone | Nội dung | Ước lượng |
|---|---|---|---|
| 1 | Skeleton | docker-compose, Express hello-world, Vite app, kết nối DB | 1–2 ngày |
| 2 | Auth | Register/login/JWT/refresh token, protected routes | 2–3 ngày |
| 3 | Quotes + Redis | Finnhub client, cache-aside, endpoint quotes — **trái tim của project** | 2–3 ngày |
| 4 | Portfolio CRUD | Portfolios, transactions, tính PnL (kèm unit tests) | 3–4 ngày |
| 5 | Dashboard UI | Holdings table, PnL chart (Recharts), form thêm giao dịch | 3–4 ngày |
| 6 | Watchlist + search | Symbol search, watchlist page | 1–2 ngày |
| 7 | Polish + deploy | Error handling, loading states, deploy (Railway/Render + Upstash Redis) | 2–3 ngày |

Tổng: ~3 tuần làm đều tay. Sau milestone 3 là bạn đã có thứ để demo và
kể chuyện Redis caching rồi.

## 9. Các con số để đưa vào resume (đo thật, đừng bịa)

- Log lại số cache hit/miss trong 1 ngày dùng thử → tính % API calls tiết kiệm.
- Đo latency: response time khi cache hit (~vài ms) vs miss (~200ms+).
- Số concurrent users test được bằng `autocannon` hoặc `k6`.

## 10. Câu hỏi phỏng vấn dự kiến & hướng trả lời

1. **"Tại sao dùng Redis mà không cache in-memory trong Node?"**
   → In-memory mất khi restart, và không share được giữa nhiều instance khi scale.
2. **"TTL 30 giây có đủ 'real-time' không?"**
   → Trade-off có chủ đích: free tier 60 calls/phút; với use case theo dõi
   danh mục (không phải trading), độ trễ 30s chấp nhận được.
3. **"Nếu 2 request cùng miss cache một lúc thì sao?"** (cache stampede)
   → Với quy mô này chấp nhận double-call; nêu được giải pháp (lock/single-flight)
   là điểm cộng lớn.
4. **"Sao không lưu số lượng cổ phiếu hiện tại vào bảng riêng?"**
   → Transactions là source of truth, tránh dữ liệu lệch — nguyên tắc quan trọng
   trong hệ thống tài chính.
