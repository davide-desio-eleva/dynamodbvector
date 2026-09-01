#!/bin/bash
# Start the local Nova Sonic voice agent server.
#
# Usage:
#   ./voice-agent/start.sh [TABLE_NAME]
#
# If TABLE_NAME is not provided, it is read from amplify_outputs.json
# (custom.ProductsTableName).
#
# Prerequisites:
#   - Python 3.12+
#   - pip install -r voice-agent/requirements.txt
#   - AWS credentials configured (for Bedrock + DynamoDB access)
#   - Nova Sonic model access enabled in eu-north-1
#   - Titan Embeddings + Nova Micro access enabled in eu-west-1

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUTS_FILE="$SCRIPT_DIR/../amplify_outputs.json"

# Read table name from the argument, or fall back to amplify_outputs.json
TABLE_NAME="$1"
if [ -z "$TABLE_NAME" ]; then
  if [ -f "$OUTPUTS_FILE" ]; then
    TABLE_NAME="$(node -e "process.stdout.write(require('$OUTPUTS_FILE').custom?.ProductsTableName || '')" 2>/dev/null || true)"
  fi
fi

if [ -z "$TABLE_NAME" ]; then
  echo "Error: could not determine the table name."
  echo "Pass it explicitly: ./voice-agent/start.sh <TABLE_NAME>"
  echo "Or make sure amplify_outputs.json exists with custom.ProductsTableName (run 'npx ampx sandbox')."
  exit 1
fi

export TABLE_NAME
export TABLE_REGION="${TABLE_REGION:-eu-west-1}"
export BEDROCK_REGION="${BEDROCK_REGION:-eu-north-1}"
export EMBEDDING_MODEL_ID="${EMBEDDING_MODEL_ID:-amazon.titan-embed-text-v2:0}"
export LLM_MODEL_ID="${LLM_MODEL_ID:-eu.amazon.nova-micro-v1:0}"

echo ""
echo "  Voice Agent Configuration"
echo "  ========================="
echo "  Table:          $TABLE_NAME"
echo "  Table Region:   $TABLE_REGION"
echo "  Bedrock Region: $BEDROCK_REGION (Nova Sonic)"
echo "  LLM Model:      $LLM_MODEL_ID (query parsing)"
echo "  Embedding:      $EMBEDDING_MODEL_ID"
echo ""

cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
else
  source .venv/bin/activate
fi

echo "Starting voice agent on ws://127.0.0.1:8080/ws ..."
echo ""
python agent.py
