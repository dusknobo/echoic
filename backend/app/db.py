from pathlib import Path

from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from app.config import settings


def create_database_engine(database_url: str, **kwargs) -> Engine:
    """Keep PostgreSQL defaults while supporting a local, threaded SQLite app."""
    if database_url.startswith("sqlite:"):
        connect_args = {"check_same_thread": False, "timeout": 30}
        connect_args.update(kwargs.pop("connect_args", {}))
        kwargs["connect_args"] = connect_args
    database_engine = create_engine(database_url, **kwargs)
    if database_engine.dialect.name == "sqlite":
        @event.listens_for(database_engine, "connect")
        def enable_foreign_keys(connection, _connection_record):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    return database_engine


engine = create_database_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


def initialize_local_database(bind: Engine | None = None) -> None:
    """Create missing local SQLite tables; PostgreSQL still uses Alembic."""
    database_engine = bind if bind is not None else engine
    if database_engine.dialect.name != "sqlite":
        raise ValueError("Local initialization requires SQLite; use Alembic for PostgreSQL")
    database_path = database_engine.url.database
    if database_path and database_path != ":memory:":
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)
    import app.models  # noqa: F401 - register every table before create_all

    Base.metadata.create_all(database_engine)
    # Preserve databases created before retry-safe marker IDs were introduced.
    # create_all creates missing tables but does not add columns to old tables.
    with database_engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("listening_markers")}
        if "client_id" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE listening_markers ADD COLUMN client_id VARCHAR(64)"
            )
        unique_names = {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("listening_markers")
        }
        if "uq_listening_markers_audio_client" not in unique_names:
            connection.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_listening_markers_audio_client "
                "ON listening_markers (audio_file_id, client_id)"
            )


def get_db():
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
