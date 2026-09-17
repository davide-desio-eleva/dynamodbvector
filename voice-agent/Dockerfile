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

# Launch under the OpenTelemetry auto-instrumentation wrapper so the ADOT SDK
# picks up the OTEL_* env vars set on the runtime and exports the spans Strands
# emits to CloudWatch. Running `python agent.py` directly would skip ADOT.
CMD ["opentelemetry-instrument", "python", "agent.py"]
