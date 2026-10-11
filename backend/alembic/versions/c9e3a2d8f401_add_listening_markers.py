"""add listening markers

Revision ID: c9e3a2d8f401
Revises: 578f7075c285
"""
from alembic import op
import sqlalchemy as sa

revision = "c9e3a2d8f401"
down_revision = "578f7075c285"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "listening_markers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("audio_file_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("time", sa.Float(), nullable=False),
        sa.Column("note", sa.String(2000), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["audio_file_id"], ["audio_files.id"], ondelete="CASCADE"),
        sa.CheckConstraint("time >= 0 AND time <= 604800", name="ck_listening_marker_time"),
        sa.UniqueConstraint("audio_file_id", "client_id", name="uq_listening_markers_audio_client"),
    )
    op.create_index("ix_listening_markers_audio_time", "listening_markers", ["audio_file_id", "time"])


def downgrade() -> None:
    op.drop_index("ix_listening_markers_audio_time", table_name="listening_markers")
    op.drop_table("listening_markers")
