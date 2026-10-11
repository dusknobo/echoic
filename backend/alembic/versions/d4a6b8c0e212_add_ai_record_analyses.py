"""add AI recording analyses
Revision ID: d4a6b8c0e212
Revises: c9e3a2d8f401
"""
from alembic import op
import sqlalchemy as sa
revision = "d4a6b8c0e212"
down_revision = "c9e3a2d8f401"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("ai_record_analyses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("record_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["record_id"], ["practice_records.id"], ondelete="CASCADE"))
    op.create_index("ix_ai_record_analyses_record_id", "ai_record_analyses", ["record_id"])


def downgrade():
    op.drop_index("ix_ai_record_analyses_record_id", table_name="ai_record_analyses")
    op.drop_table("ai_record_analyses")
