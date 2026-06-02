# Glossary

Domain-specific terms, abbreviations, and concepts used in the **sample-semantic-layer-structured** codebase.

| Term | Definition | Where Used |
|------|-----------|-----------|
| **VKG (Virtual Knowledge Graph)** | A semantic layer that stores concept→table/column mappings in an ontology rather than copying data into the graph; queries resolve to SQL against the source data. | README, frontend, query agent |
| **Ontology** | An OWL/RDF model of business concepts, relationships, and their mappings to physical tables; the knowledge layer of the system. | `agents/ontology_agent`, Neptune |
| **N-Quads** | The RDF serialization (subject, predicate, object, named-graph) the ontology agent generates and persists to Neptune. | `ontology_agent/main.py` |
| **mapsToTable / mapsToColumn** | Custom RDF predicates that record which physical Glue table/column an ontology concept maps to, giving the VKG its traceability. | Ontology N-Quads, query agent |
| **SPARQL** | The query language used to look up the ontology in Amazon Neptune before generating SQL. | `ontology_query_agent`, `neptune-tools` |
| **Strands Agent** | An agent built with the Strands Agents SDK; both the ontology and query agents are Strands agents running on Bedrock AgentCore. | `agents/` |
| **AgentCore Runtime** | Amazon Bedrock AgentCore container runtime hosting each agent (ontology + ontology-query). | `cdk/.../agentcore-stack.ts`, Dockerfiles |
| **AgentCore Gateway** | An HTTP gateway that lets agents reach VPC-isolated Neptune without VPC attachment, backed by the `neptune-tools` MCP Lambda. | `agentcore/neptune-gateway-construct.ts` |
| **MCP (Model Context Protocol)** | The tool-provider protocol the `neptune-tools` Lambda implements to expose SPARQL operations to agents via the gateway. | `lambda/neptune-tools` |
| **Supervisor / supervisor runner** | The iterative control loop in the query agent that orchestrates ontology lookup, SQL generation, and execution rather than answering in a single shot. | `ontology_query_agent/supervisor.py`, `supervisor_runner.py` |
| **Schema digest** | A condensed representation of table schemas the query agent uses to ground SQL generation. | `ontology_query_agent/schema_digest.py` |
| **Zero-ETL** | AWS Glue integrations that batch-replicate each DynamoDB table into S3 Tables without custom ETL code. | `cdk/.../zeroetl`, README |
| **zetl_<uuid> namespace** | The S3 Tables namespace each Zero-ETL integration creates as internal replication staging. | NormalizedViewsStack, README |
| **Normalized views** | 40 Iceberg materialized views (in the `normalized` namespace) built by a Glue 5.1 PySpark job, demultiplexing flat Zero-ETL tables into entity tables. | `glue/create-normalized-views.py` |
| **S3 Tables / Iceberg** | Apache Iceberg tables stored in Amazon S3 Tables, governed by Lake Formation, forming the analytical data layer. | Data Lake stack, Athena |
| **Bedrock Guardrails** | Amazon Bedrock content/PII screening applied to query input (pre-screen) and agent output (post-screen). | `guardrail_service.py`, GuardrailsStack |
| **Bedrock Knowledge Base** | An S3-Vectors-backed vector store of OWL ontology design patterns the ontology agent retrieves from during generation. | `bedrock-kb-stack.ts`, ontology agent |
| **Lake Formation** | AWS fine-grained access control governing S3 Tables / Iceberg namespaces. | Data Lake, AgentCore, Athena stacks |
| **Mangum** | The adapter that wraps the FastAPI app as an AWS Lambda handler. | `lambda/rest-api/main.py` |

---

*Back to [Index](index.md)*
