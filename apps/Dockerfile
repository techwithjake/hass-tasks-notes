ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12-alpine3.23
FROM $BUILD_FROM

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir --root-user-action=ignore -r requirements.txt

COPY app/ .
COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT ["/run.sh"]
