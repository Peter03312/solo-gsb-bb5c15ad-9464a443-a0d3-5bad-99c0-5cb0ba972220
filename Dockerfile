# 字幕校时工作台：单容器镜像（依赖安装 + 数据初始化 + 启动一体化）
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 优先使用预编译二进制；下载不可用时回退源码编译，故备好工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用镜像层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝应用
COPY server.js ./
COPY src ./src
COPY public ./public
COPY examples ./examples

# SQLite 数据目录（可挂卷持久化）；以非 root 运行
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=3000 \
    DB_PATH=/data/subtitles.db \
    SEED_DEMO=true

EXPOSE 3000

# 启动时自动建表（见 src/db.js），库为空且 SEED_DEMO=true 时播种演示项目
CMD ["node", "server.js"]
