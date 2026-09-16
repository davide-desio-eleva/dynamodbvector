# AgentCore Runtime requires linux/arm64 containers listening on port 8080.
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the agent code
COPY agent.py .

# AgentCore Runtime convention: server on 0.0.0.0:8080, WebSocket at /ws, health at /ping
ENV CONTAINER_ENV=true
EXPOSE 8080

CMD ["python", "agent.py"]
