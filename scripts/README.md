# Semantic Layer Scripts

This directory contains scripts for managing the semantic layer project.

## Contents

### Ontology Management Scripts

- **download-ontologies.sh** - Downloads reference ontologies (FIBO, ACORD, FHIR, W3C, etc.)
- **convert-ontologies.py** - Converts RDF/OWL ontologies and XSD schemas to Markdown format
- **ontology-requirements.txt** - Python dependencies for ontology scripts
- **ONTOLOGY_SCRIPTS_README.md** - Detailed documentation for ontology scripts

### Maintenance Scripts

- **repoint_metadata_to_normalized.py** - Repoints a semantic-layer-metadata row at the `normalized` S3 Tables namespace and re-runs ontology generation

## Directory Structure

```
scripts/
├── README.md                           # This file
├── download-ontologies.sh              # Ontology downloader
├── convert-ontologies.py               # Ontology converter
├── ontology-requirements.txt           # Python deps for ontology scripts
├── ONTOLOGY_SCRIPTS_README.md          # Ontology scripts documentation
└── repoint_metadata_to_normalized.py   # Metadata repoint / regenerate helper
```

## Data Directory Structure

Scripts write to the `/data/` directory:

```
data/
├── ontology-sources/                   # Downloaded ontologies (git-ignored)
│   ├── fibo/
│   ├── acord/                          # ACORD XSD schemas (user-provided)
│   ├── fhir/
│   └── w3c/
└── ontology-docs/                      # Converted markdown (git-ignored)
    ├── fibo/
    ├── acord/
    ├── fhir/
    └── w3c/
```

## Quick Start

### Setup Reference Ontologies

```bash
# Download ontologies (~500MB, takes 2-5 minutes)
chmod +x download-ontologies.sh
./download-ontologies.sh

# Convert to Markdown
pip install -r ontology-requirements.txt
python3 convert-ontologies.py
```

## Documentation

- **Ontology Scripts**: See `ONTOLOGY_SCRIPTS_README.md` in this directory

## Notes

- All scripts should be run from this directory
- Large data files are git-ignored (see `/data/.gitignore`)
- Scripts write to `/data/` subdirectories, not to script directory
