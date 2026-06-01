"""
Query API Endpoints

Provides REST API endpoints for natural language query processing:
- Submit natural language query
- Get query result
- Get query status
- List query history
- Delete query
"""

import logging
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from services.query_service import QueryService
from services.agentcore_service import AgentCoreService

logger = logging.getLogger(__name__)

# Create FastAPI app for query endpoints
app = FastAPI(title="Query API")

# Initialize services
query_service = QueryService()
agentcore_service = AgentCoreService()


# Pydantic models for request/response validation
class SubmitQueryRequest(BaseModel):
    question: str
    id: str
    # 'supervisor' (default) runs the judge-driven retry loop;
    # 'single_shot' runs the agent once with no supervisor wrapping.
    mode: str = 'supervisor'


# ============================================================================
# Query Submission and Results Endpoints
# ============================================================================

@app.post("/submit")
async def submit_query(request: SubmitQueryRequest):
    """
    Submit a natural language query for processing

    This endpoint:
    1. Converts natural language to SQL using Amazon Bedrock
    2. Executes the SQL query on Amazon Athena
    3. Returns a query ID for tracking

    Args:
        request: Query request with question and ontology ID

    Returns:
        Query ID and initial status
    """
    try:
        result = query_service.submit_query(
            question=request.question,
            id=request.id,
            mode=request.mode,
        )

        return JSONResponse(content=result, status_code=202)

    except Exception as e:
        logger.error(f"Error submitting query: {e}")  # nosemgrep: logging-error-without-handling — exception converted to HTTPException, not re-raised as-is
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/result/{query_id}")
async def get_query_result(query_id: str):
    """
    Get the result of a completed query

    Args:
        query_id: Unique identifier for the query

    Returns:
        Query results including:
        - Original question
        - Generated SQL query
        - Result rows (up to 1000)
        - Execution metadata
    """
    try:
        result = query_service.get_query_result(query_id)

        if result.get('status') == 'NOT_FOUND':
            raise HTTPException(status_code=404, detail="Query not found")

        return JSONResponse(content=result)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting query result: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/status/{query_id}")
async def get_query_status(query_id: str):
    """
    Get the status of a query

    Args:
        query_id: Unique identifier for the query

    Returns:
        Query status (SUBMITTED, RUNNING, SUCCEEDED, FAILED, CANCELLED)
    """
    try:
        status = query_service.get_query_status(query_id)

        if status.get('status') == 'NOT_FOUND':
            raise HTTPException(status_code=404, detail="Query not found")

        return JSONResponse(content=status)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting query status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Health check
@app.get("/health")
async def health_check():
    """Health check endpoint for query API"""
    return {"status": "healthy", "service": "query-api"}
