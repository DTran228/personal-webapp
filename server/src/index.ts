import express, { type Express, type Request, type Response } from 'express';

const app: Express = express();
const port = 3000;

app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: "ok" });
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});