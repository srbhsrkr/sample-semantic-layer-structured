# Ontology Pattern Library

This directory holds OWL ontology design pattern documents that are synced to the
`ontology-patterns/` prefix of the artifacts S3 bucket and indexed by the Bedrock
Knowledge Base. The Ontology Generation Agent retrieves from this KB during build
to apply established design patterns to the user's schema.

Drop pattern documents here as `.txt`, `.md`, or `.owl` files. Each document is
chunked and embedded by Titan Embed Text v2.

This file exists so the CDK `BucketDeployment` has a valid asset source even when
no patterns have been added yet.
