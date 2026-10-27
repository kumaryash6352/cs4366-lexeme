# Lexeme
## Run

```sh
npm install
npm run dev
```
```sh
npm run dev:web   # browser-only
npm run typecheck
npm run lint
npm run build     # bundle 
npm start         # run build first
```

### Backend

```text
backend/
├── routes/
│   ├── loader.ts
│   └── analyze.ts
├── app.ts    # main backend code
└── server.ts # will soon contain server code
```

#### install: 
```sh
npm i fastify
```
#### run
```sh
cd backend 
node fastify
```
