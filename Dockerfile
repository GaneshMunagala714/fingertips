FROM python:3.13-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/ server/
COPY web/ web/
# ASL model + preprocessing from Fingertip (by Shruti); .dockerignore keeps only those files
COPY fingertip/ fingertip/
EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
