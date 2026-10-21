FROM python:3.10-slim

WORKDIR /app

# 依存関係ファイルのコピーとインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ソースコードのコピー
COPY . .

# Flaskでローカルファイルを保存するための作業ディレクトリを作成
RUN mkdir -p /app/data

# 環境変数で動的ポート指定されるため、シェル形式で gunicorn を起動
# (シェル形式で記述することで $PORT が展開されます)
CMD gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 0 server:app
