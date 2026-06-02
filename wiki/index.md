# sample-semantic-layer-structured

**sample-semantic-layer-structured** is an AWS CDK + Strands Agents + React solution that builds a **Virtual Knowledge Graph (VKG)** semantic layer over structured insurance data and answers natural-language questions against it. An OWL ontology is generated from the AWS Glue catalog, persisted in Amazon Neptune as RDF/OWL, and used by AI agents to translate plain English into SPARQL → SQL executed on Amazon Athena.

This branch (`ontology-layer-only`) is the **VKG-only customer distribution**. The full reference implementation — including Semantic RAG, real-time change-data-capture (CDC), and the AgentCore evaluation harness — lives on the `main` branch. The distribution ships no sample data: customers load their own operational data into the provided table schema and let the pipeline replicate and normalize it.

## Quick Stats

| Metric | Value |
|--------|-------|
| Primary Language(s) | Python, TypeScript, JavaScript/JSX |
| Lines of Code | ~38,000 (≈125 source files) |
| Total Commits | 2 (on this branch) |
| Contributors | 2 (Felix Huthmacher, Saurabh Sarkar) |
| Project Age | 2026-04-01 — present |
| Latest Activity | 2026-06-01 |
| License | MIT-0 (MIT No Attribution) |

## Contents

- [Architecture](architecture.md) — System design, layers, component & data-flow diagrams
- [Modules](modules/) — Detailed documentation for each major module
  - [CDK Infrastructure](modules/cdk.md) — 15-stack AWS CDK v2 application
  - [Ontology Agent](modules/ontology-agent.md) — OWL ontology generation from Glue schemas
  - [Ontology Query Agent](modules/ontology-query-agent.md) — Natural-language → SPARQL → SQL query agent
  - [Lambda REST API](modules/lambda-rest-api.md) — FastAPI HTTP API orchestrating the agents
  - [Frontend](modules/frontend.md) — React + Cloudscape admin and query UI
- [Journey](journey.md) — The project's evolution from first commit to today
- [Contributors](contributors.md) — Who built what
- [Glossary](glossary.md) — Domain terms and definitions

## Getting Started

The deployment runs end-to-end on AWS via CDK. In brief:

1. **Prerequisites** — AWS CLI v2, Node.js 18+, AWS CDK v2, Python 3.12+, and Docker. In the AWS account: administrator access, region **us-east-1** (with the AgentCore AZ-ID caveat), and **Bedrock model access** for Anthropic Claude + Titan Text Embeddings V2.
2. **Deploy** — `cdk bootstrap`, then `cd cdk && npm install && npm run build && cdk deploy --all` (~35–50 min, includes ARM64 CodeBuild for the Lambda + 2 agent images).
3. **Load your data** — the 12 DynamoDB tables are created empty; load your own data using the `pk`/`sk` schema, and Glue Zero-ETL → normalized views replicate it automatically.
4. **Build & query** — create Cognito users, upload ontology patterns, then use the admin flow to build the knowledge graph and the query page to ask questions.

See the root `README.md` "Getting Started" section for the full prerequisites table and step-by-step instructions.
