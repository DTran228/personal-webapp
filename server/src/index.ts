import "dotenv/config";
import express, { type Express, type Request, type Response } from 'express';
import { pool } from "./db/pool.js";
import { redis } from "./lib/redis.js";

const app: Express = express();
const port = 3000;

app.get('/api/health', async (req: Request, res: Response) => {
    let postgres = false;
    let redisOk = false;

    try {
        await pool.query("SELECT 1")
        postgres = true;
    } catch {

    }

    try {
        await redis.ping()
        redisOk = true;
    } catch {
        
    }

    res.json({ status: "ok", postgres, redis: redisOk });
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});