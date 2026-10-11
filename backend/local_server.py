"""Run Echoic locally without Docker or a database service."""
import argparse

from local_runtime import configure

configure()

from app.db import initialize_local_database
initialize_local_database()

from app.main import app


@app.get("/api/local/health")
def local_health():
    return {"application": "Echoic", "deployment": "native", "database": "sqlite"}


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
