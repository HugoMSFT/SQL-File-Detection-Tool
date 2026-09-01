from pathlib import Path
import json
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


root = Path(__file__).resolve().parents[1] / 'data sample'
csv_root = root / 'csv'
json_root = root / 'json'
tables_root = root / 'tables'
for directory in (csv_root, json_root, tables_root):
    directory.mkdir(parents=True, exist_ok=True)

employees = pd.DataFrame([
    {"employee_id": 1001, "first_name": "Alice", "last_name": "Ng", "department": "Engineering", "title": "Senior Engineer", "salary": 132500.75, "hire_date": "2021-03-15", "is_active": True, "office": "Seattle", "country": "USA"},
    {"employee_id": 1002, "first_name": "Bob", "last_name": "Patel", "department": "Finance", "title": "Analyst", "salary": 91500.00, "hire_date": "2022-09-01", "is_active": True, "office": "London", "country": "UK"},
    {"employee_id": 1003, "first_name": "Carla", "last_name": "Meyer", "department": "Sales", "title": "Account Manager", "salary": 105300.50, "hire_date": "2020-11-20", "is_active": False, "office": "Berlin", "country": "DE"},
])
employees.to_csv(csv_root / 'employees_wide.csv', index=False)

orders = pd.DataFrame([
    {"order_id": "SO-001", "customer_id": 501, "region": "NA", "channel": "online", "item_count": 3, "subtotal": 89.90, "tax": 7.19, "shipping": 4.99, "total": 102.08, "order_ts": "2026-01-10T09:15:00Z"},
    {"order_id": "SO-002", "customer_id": 777, "region": "EU", "channel": "partner", "item_count": 1, "subtotal": 349.00, "tax": 69.80, "shipping": 0.00, "total": 418.80, "order_ts": "2026-01-11T14:42:00Z"},
    {"order_id": "SO-003", "customer_id": 321, "region": "APAC", "channel": "retail", "item_count": 2, "subtotal": 149.00, "tax": 11.92, "shipping": 6.50, "total": 167.42, "order_ts": "2026-01-12T18:05:00Z"},
])
orders.to_csv(csv_root / 'sales_orders.csv', index=False)

customers = [
    {
        "customer_id": 501,
        "name": "Contoso Ltd",
        "tier": "gold",
        "contacts": [{"name": "Ana", "email": "ana@contoso.com"}, {"name": "Lee", "email": "lee@contoso.com"}],
        "address": {"city": "Seattle", "country": "USA"},
        "active": True,
    },
    {
        "customer_id": 777,
        "name": "Fabrikam GmbH",
        "tier": "silver",
        "contacts": [{"name": "Marta", "email": "marta@fabrikam.de"}],
        "address": {"city": "Berlin", "country": "DE"},
        "active": True,
    },
]
(json_root / 'customers_nested.json').write_text(
    json.dumps(customers, indent=2),
    encoding='utf-8',
)

jsonl_rows = [
    {"event_id": 1, "event_type": "login", "user_id": "u-100", "success": True, "ts": "2026-03-01T08:20:00Z"},
    {"event_id": 2, "event_type": "purchase", "user_id": "u-100", "success": True, "amount": 49.99, "ts": "2026-03-01T08:25:14Z"},
    {"event_id": 3, "event_type": "logout", "user_id": "u-100", "success": True, "ts": "2026-03-01T08:30:01Z"},
]
(json_root / 'events.jsonl').write_text(
    "\n".join(json.dumps(r) for r in jsonl_rows) + "\n",
    encoding='utf-8',
)

delta_root = tables_root / 'delta_table'
(delta_root / '_delta_log').mkdir(parents=True, exist_ok=True)
(delta_root / 'data').mkdir(parents=True, exist_ok=True)

delta_df = pd.DataFrame([
    {"id": 1, "product": "Laptop", "price": 1299.0, "category": "electronics"},
    {"id": 2, "product": "Chair", "price": 199.5, "category": "furniture"},
    {"id": 3, "product": "Notebook", "price": 4.2, "category": "office"},
])
parquet_rel = 'data/part-00000-00000.snappy.parquet'
pq.write_table(pa.Table.from_pandas(delta_df), delta_root / parquet_rel, compression='snappy')

delta_log = {
    "protocol": {"minReaderVersion": 1, "minWriterVersion": 2},
    "metaData": {
        "id": "sample-delta-table",
        "format": {"provider": "parquet", "options": {}},
        "schemaString": json.dumps({
            "type": "struct",
            "fields": [
                {"name": "id", "type": "long", "nullable": False, "metadata": {}},
                {"name": "product", "type": "string", "nullable": True, "metadata": {}},
                {"name": "price", "type": "double", "nullable": True, "metadata": {}},
                {"name": "category", "type": "string", "nullable": True, "metadata": {}},
            ],
        }),
        "partitionColumns": [],
        "configuration": {},
        "createdTime": 1760000000000,
    },
    "add": {
        "path": parquet_rel,
        "size": int((delta_root / parquet_rel).stat().st_size),
        "modificationTime": 1760000000000,
        "dataChange": True,
    },
}
(delta_root / '_delta_log' / '00000000000000000000.json').write_text(
    "\n".join(json.dumps({k: v}) for k, v in delta_log.items()) + "\n",
    encoding='utf-8'
)

iceberg_root = tables_root / 'iceberg_table'
(iceberg_root / 'metadata').mkdir(parents=True, exist_ok=True)
(iceberg_root / 'data').mkdir(parents=True, exist_ok=True)

iceberg_df = pd.DataFrame([
    {"txn_id": "T-100", "store": "SEA-01", "amount": 120.5, "txn_date": "2026-02-01"},
    {"txn_id": "T-101", "store": "LON-04", "amount": 89.0, "txn_date": "2026-02-02"},
    {"txn_id": "T-102", "store": "BER-03", "amount": 210.7, "txn_date": "2026-02-03"},
])
iceberg_data_file = iceberg_root / 'data' / '00000-0.parquet'
pq.write_table(pa.Table.from_pandas(iceberg_df), iceberg_data_file, compression='snappy')

iceberg_metadata = {
    "format-version": 2,
    "table-uuid": "sample-iceberg-table",
    "location": "data sample/tables/iceberg_table",
    "last-sequence-number": 1,
    "last-updated-ms": 1760000000000,
    "last-column-id": 4,
    "current-schema-id": 0,
    "schemas": [{
        "type": "struct",
        "schema-id": 0,
        "fields": [
            {"id": 1, "name": "txn_id", "required": True, "type": "string"},
            {"id": 2, "name": "store", "required": False, "type": "string"},
            {"id": 3, "name": "amount", "required": False, "type": "double"},
            {"id": 4, "name": "txn_date", "required": False, "type": "date"},
        ],
    }],
    "partition-specs": [{"spec-id": 0, "fields": []}],
    "sort-orders": [{"order-id": 0, "fields": []}],
    "default-sort-order-id": 0,
    "default-spec-id": 0,
    "current-snapshot-id": None,
    "snapshots": [],
    "snapshot-log": [],
    "metadata-log": [],
    "properties": {"write.format.default": "parquet"},
}
(iceberg_root / 'metadata' / 'v1.metadata.json').write_text(json.dumps(iceberg_metadata, indent=2), encoding='utf-8')

print(f'Created additional sample datasets in {root}')
