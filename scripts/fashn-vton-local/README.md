# 1-Click Local Free FASHN VTON v1.5

Run the automated 1-Click setup script (it clones repo, installs dependencies, downloads weights, and starts the server automatically):

```bash
bash scripts/fashn-vton-local/setup_and_run.sh
```

---

## Shop Nexus `.env` Configuration

Make sure your project `.env` contains:

```env
VTO_PROVIDER="fashn"
FASHN_API_MODE="sync"
FASHN_VM_URL="http://127.0.0.1:8000"
FASHN_API_KEY=""
FASHN_TIMEOUT_MS="300000"
FASHN_NUM_INFERENCE_STEPS="30"
```

Restart the Shopify app after changing `.env`.