import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SpaceBetween, Header, Box } from '@cloudscape-design/components';
import { ontologyAPI } from '../../services/api';

export default function SelectSemanticLayerType() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await ontologyAPI.createOntologyConfig({ id, type: 'VKG' });
        if (cancelled) return;
        if (!result.success) {
          setError(result.error || 'Failed to set semantic layer type');
          return;
        }
        navigate(`/admin/build-graph?id=${id}`);
      } catch (e) {
        if (!cancelled) setError(e.message || 'An error occurred');
      }
    })();
    return () => { cancelled = true; };
  }, [id, navigate]);

  return (
    <SpaceBetween size="l">
      <Header variant="h1">Select Semantic Layer Type</Header>
      {error
        ? <Box color="text-status-error">{error}</Box>
        : <Box>Configuring Virtual Knowledge Graph...</Box>
      }
    </SpaceBetween>
  );
}
