import React, { useState, useEffect } from 'react';
import {
  Container,
  Header,
  SpaceBetween,
  Button,
  Alert,
  Box,
  FormField,
  Textarea,
  Select,
  StatusIndicator,
  ExpandableSection,
  Table,
  Tabs,
  Toggle,
} from '@cloudscape-design/components';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { queryAPI, ontologyAPI } from '../../services/api';
import ReactMarkdown from 'react-markdown';

export default function NaturalLanguageQuery({ user, addNotification }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefilledQuestion = searchParams.get('q');

  const [question, setQuestion] = useState(prefilledQuestion || '');
  const [selectedOntology, setSelectedOntology] = useState(null);
  const [ontologies, setOntologies] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [queryResult, setQueryResult] = useState(null);
  const [activeTab, setActiveTab] = useState('answer');
  const [error, setError] = useState(null);
  const [clarification, setClarification] = useState(null);
  // clarification shape: { question: string, options: [{id, label}] }
  const [currentStep, setCurrentStep] = useState('');
  // Advanced toggle: ON (default) → supervisor (judge-driven retry loop);
  //                  OFF          → single_shot (one-pass agent call).
  const [advancedMode, setAdvancedMode] = useState(true);

  useEffect(() => {
    loadOntologies();
  }, []);

  // Map raw step keys (written by the lambda worker + agent) to user-friendly
  // labels. Keep this list in sync with the producers in
  // lambda/rest-api/services/query_service.py and
  // agents/ontology_query_agent/main.py.
  const STEP_LABELS = {
    validating_input: 'Validating your question…',
    invoking_agent: 'Invoking the query agent…',
    invoking_agent_supervisor: 'Invoking the query agent (supervisor)…',
    invoking_agent_single_shot: 'Invoking the query agent (single shot)…',
    fetching_ontology: 'Loading the knowledge graph…',
    querying_neptune: 'Exploring the knowledge graph…',
    disambiguating_terms: 'Resolving terms against the ontology…',
    generating_sql: 'Generating SQL…',
    running_athena: 'Running Athena query…',
    mapping_to_rdf: 'Mapping results to RDF…',
    summarizing: 'Summarizing the answer…',
    processing_response: 'Finalizing the response…',
  };

  const markdownHeadingComponents = {
    h1: ({ children }) => <strong style={{ fontSize: '0.85rem' }}>{children}</strong>,
    h2: ({ children }) => <strong style={{ fontSize: '0.8rem' }}>{children}</strong>,
    h3: ({ children }) => <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>{children}</span>,
    h4: ({ children }) => <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>{children}</span>,
    h5: ({ children }) => <span style={{ fontWeight: 600 }}>{children}</span>,
    h6: ({ children }) => <span style={{ fontWeight: 600 }}>{children}</span>,
  };

  const loadOntologies = async () => {
    const result = await ontologyAPI.listOntologies();
    if (result.success) {
      const completed = (result.data.ontologies || []).filter(
        (o) => o.status === 'completed'
      );

      // Fetch full config for each ontology to get type and databaseName
      const options = [];
      for (const o of completed) {
        const configResult = await ontologyAPI.getOntologyConfig(o.id);
        if (configResult.success) {
          const config = configResult.data;
          options.push({
            label: o.name || o.id,
            value: o.id,
            type: config.type || 'VKG',
            id: o.id,
            name: o.name,
          });
        }
      }

      setOntologies(options);

      if (options.length > 0) {
        setSelectedOntology(options[0]);
      }
    }
  };

  const handleSubmit = async (overrideQuestion = null) => {
    const currentQuestion = overrideQuestion || question;
    if (!currentQuestion.trim() || !selectedOntology) {
      setError('Please enter a question and select a semantic knowledge base');
      return;
    }

    setError(null);
    setSubmitting(true);
    setQueryResult(null);
    setActiveTab('answer');
    setCurrentStep('validating_input');

    try {
      const result = await queryAPI.submitQuery(
        currentQuestion,
        selectedOntology.value,
        advancedMode ? 'supervisor' : 'single_shot'
      );

      if (result.success) {
        const queryId = result.data.queryId;
        const notificationId = `query-${queryId}`;

        addNotification?.({
          type: 'info',
          content: 'Query submitted. Processing...',
          dismissible: true,
          id: notificationId,
        });

        const finalResult = await queryAPI.pollQueryUntilComplete(queryId, {
          onStatus: (s) => {
            if (s?.current_step) setCurrentStep(s.current_step);
          },
        });

        if (finalResult.success) {
          const data = finalResult.data;
          if (data.needs_clarification) {
            setClarification({
              question: data.clarification_question,
              options: data.options || [],
            });
          } else {
            setQueryResult(data);
            setClarification(null);
          }

          addNotification?.({
            type: 'success',
            content: 'Query completed successfully!',
            dismissible: true,
            id: notificationId,
          });
        } else {
          const isBlocked = finalResult.status === 'BLOCKED';
          const headline = isBlocked ? 'Query blocked by content policy' : 'Query failed';
          const detail = finalResult.error || 'Unknown error';
          setError(`${headline}: ${detail}`);
          addNotification?.({
            type: isBlocked ? 'warning' : 'error',
            content: `${headline}: ${detail}`,
            dismissible: true,
            id: notificationId,
          });
        }
      } else {
        setError(result.error || 'Failed to submit query');
      }
    } catch (err) {
      setError(err.message || 'An error occurred');
    } finally {
      setSubmitting(false);
      setCurrentStep('');
    }
  };

  const handleClarification = (option) => {
    const enriched = `${question} — clarification: ${option.label}`;
    setClarification(null);
    setQuestion(enriched);
    handleSubmit(enriched);
  };

  const handleAskFollowUp = () => {
    setQuestion('');
    setQueryResult(null);
    setClarification(null);
    setActiveTab('answer');
  };

  // Extract plain-text answer — guard against the agent embedding the full
  // JSON blob inside the answer field (common with some model responses).
  const extractAnswer = (raw) => {
    if (!raw) return '';
    if (typeof raw !== 'string') return String(raw);
    const trimmed = raw.trim();
    // If it looks like JSON, try to parse and pull the inner answer field
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.answer === 'string' && parsed.answer) {
          return parsed.answer;
        }
      } catch (_) {
        // Not valid JSON — fall through and use raw string
      }
    }
    return raw;
  };

  // Derive display data from result
  const results = queryResult?.results || [];
  const sqlQuery = queryResult?.sql_query || '';
  const reasoning = queryResult?.reasoning || {};
  const hasReasoning = reasoning && Object.keys(reasoning).some((k) => reasoning[k]);
  const kbSources = (queryResult?.n_quads || []).filter((s) => typeof s === 'object' && s.sourceUri !== undefined);
  const columnDefs =
    results.length > 0
      ? Object.keys(results[0]).map((key) => ({
          id: key,
          header: key,
          cell: (item) => {
            const val = item[key];
            return val === null || val === undefined || val === '' ? '-' : String(val);
          },
        }))
      : [];

  const resultsTabs = queryResult
    ? [
        {
          label: 'Answer',
          id: 'answer',
          content: (
            <Box padding="m">
              <ReactMarkdown>{extractAnswer(queryResult.answer) || 'No answer generated'}</ReactMarkdown>
            </Box>
          ),
        },
        {
          label: sqlQuery ? 'SQL Query ✓' : 'SQL Query',
          id: 'sql',
          content: sqlQuery ? (
            <Box padding="m">
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  background: 'var(--color-background-code-editor-default, #f4f4f4)',
                  padding: '16px',
                  borderRadius: '4px',
                }}
              >
                {sqlQuery}
              </pre>
            </Box>
          ) : (
            <Box padding="m" color="text-status-inactive" textAlign="center">
              No SQL query available
            </Box>
          ),
        },
        {
          label: `Results${results.length > 0 ? ` (${results.length})` : ''}`,
          id: 'results',
          content:
            results.length > 0 ? (
              <Table
                columnDefinitions={columnDefs}
                items={results}
                variant="embedded"
                stripedRows
                stickyHeader
                empty={
                  <Box textAlign="center" color="text-status-inactive">
                    No results found
                  </Box>
                }
              />
            ) : (
              <Box padding="m" color="text-status-inactive" textAlign="center">
                No result rows returned
              </Box>
            ),
        },
      ]
    : [];

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="Ask questions about your data in natural language"
      >
        Natural Language Query
      </Header>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <SpaceBetween size="l">
          <Container>
            <SpaceBetween size="l">
              <FormField
                label="Select Semantic Knowledge Base"
                description="Choose which semantic knowledge base to query against"
              >
                <Select
                  selectedOption={selectedOntology}
                  onChange={({ detail }) => setSelectedOntology(detail.selectedOption)}
                  options={ontologies}
                  placeholder="Select a semantic knowledge base"
                  disabled={ontologies.length === 0}
                  empty="No ontologies available"
                />
              </FormField>

              <FormField
                label="Your Question"
                description="Ask any question about your data in plain English"
              >
                <Textarea
                  value={question}
                  onChange={({ detail }) => setQuestion(detail.value)}
                  placeholder="Example: What are the active policies for customers in New York state?"
                  rows={4}
                  disabled={submitting}
                />
              </FormField>

              <FormField
                label="Advanced (supervisor loop)"
                description={
                  advancedMode
                    ? 'Supervisor judges each answer and retries with hints when it falls short. Slower but more accurate on multi-hop questions.'
                    : 'Single-shot — one agent call, no judge or retry. Faster, but errors are not corrected.'
                }
              >
                <Toggle
                  checked={advancedMode}
                  onChange={({ detail }) => setAdvancedMode(detail.checked)}
                  disabled={submitting}
                >
                  {advancedMode ? 'Supervisor' : 'Single shot'}
                </Toggle>
              </FormField>

              <Box>
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="primary"
                    onClick={() => handleSubmit()}
                    loading={submitting}
                    disabled={!question.trim() || !selectedOntology || submitting}
                  >
                    {submitting ? 'Processing...' : 'Ask Question'}
                  </Button>
                  {queryResult && (
                    <Button onClick={handleAskFollowUp}>
                      Ask Another Question
                    </Button>
                  )}
                </SpaceBetween>
              </Box>
            </SpaceBetween>
          </Container>

          {clarification && !submitting && (
            <Container
              header={<Header variant="h2">Clarification needed</Header>}
            >
              <SpaceBetween size="m">
                <Box variant="p">{clarification.question}</Box>
                <SpaceBetween direction="horizontal" size="xs">
                  {clarification.options.map((opt) => (
                    <Button key={opt.id} onClick={() => handleClarification(opt)}>
                      {opt.label}
                    </Button>
                  ))}
                </SpaceBetween>
              </SpaceBetween>
            </Container>
          )}

          {submitting && (
            <Container>
              <Box textAlign="center" padding="l">
                <StatusIndicator type="loading">
                  {STEP_LABELS[currentStep] || 'Processing your query. This may take a few moments…'}
                </StatusIndicator>
              </Box>
            </Container>
          )}

          {queryResult && (
            <SpaceBetween size="l">
              <Container
                header={<Header variant="h2">Query Results</Header>}
              >
                <Tabs
                  tabs={resultsTabs}
                  activeTabId={activeTab}
                  onChange={({ detail }) => setActiveTab(detail.activeTabId)}
                />
              </Container>

              {kbSources.length > 0 && (
                <Container>
                  <ExpandableSection
                    headerText={`Knowledge Base Sources (${kbSources.length})`}
                    variant="container"
                  >
                    <SpaceBetween size="m">
                      {kbSources.map((src, i) => (
                        <Box key={i}>
                          <SpaceBetween size="xxs">
                            <Box variant="awsui-key-label">
                              {src.tableName
                                ? `${src.tableName}${src.database ? ` (${src.database})` : ''}`
                                : src.sourceUri || `Source ${i + 1}`}
                            </Box>
                            {src.excerpt && (
                              <Box color="text-body-secondary" fontSize="body-s">
                                <ReactMarkdown components={markdownHeadingComponents}>{src.excerpt}</ReactMarkdown>
                              </Box>
                            )}
                            <Box fontSize="body-s" color="text-status-inactive">
                              Relevance: {(src.score * 100).toFixed(0)}%
                            </Box>
                          </SpaceBetween>
                        </Box>
                      ))}
                    </SpaceBetween>
                  </ExpandableSection>
                </Container>
              )}

              {hasReasoning && (
                <Container>
                  <ExpandableSection
                    headerText="View Reasoning Steps"
                    variant="container"
                  >
                    <SpaceBetween size="m">
                      {reasoning.interpretation && (
                        <Box>
                          <Box variant="awsui-key-label">1. Question Interpretation</Box>
                          <Box variant="p">{reasoning.interpretation}</Box>
                        </Box>
                      )}

                      {reasoning.graphTraversal && (
                        <Box>
                          <Box variant="awsui-key-label">2. Context Retrieval</Box>
                          <Box variant="p">{reasoning.graphTraversal}</Box>
                        </Box>
                      )}

                      {reasoning.dataSourceSelection && (
                        <Box>
                          <Box variant="awsui-key-label">3. Data Source Selection</Box>
                          <Box variant="p">{reasoning.dataSourceSelection}</Box>
                        </Box>
                      )}

                      {reasoning.sqlQuery && (
                        <Box>
                          <Box variant="awsui-key-label">4. SQL Query Generated</Box>
                          <Box padding="s">
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: '13px' }}>
                              {reasoning.sqlQuery}
                            </pre>
                          </Box>
                        </Box>
                      )}

                      {reasoning.summarization && (
                        <Box>
                          <Box variant="awsui-key-label">5. Result Summary</Box>
                          <Box variant="p">{reasoning.summarization}</Box>
                        </Box>
                      )}
                    </SpaceBetween>
                  </ExpandableSection>
                </Container>
              )}
            </SpaceBetween>
          )}

          {ontologies.length === 0 && (
            <Container>
              <Alert type="warning">
                No semantic knowledge bases available. Please complete the admin setup process first.
              </Alert>
              <Box margin={{ top: 'm' }}>
                <Button onClick={() => navigate('/admin')}>
                  Go to Admin Dashboard
                </Button>
              </Box>
            </Container>
          )}
      </SpaceBetween>
    </SpaceBetween>
  );
}
