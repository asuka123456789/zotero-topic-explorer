export type Role = "explorer" | "literature" | "feasibility" | "moderator";
export const STEP_NAMES = [
  "explore",
  "literature",
  "feasibility",
  "literature_challenge",
  "feasibility_challenge",
  "synthesize",
] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type CardStatus = "exploring" | "experiment" | "paused" | "discarded";
export type RunState =
  | "awaiting_confirmation"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type StepState =
  | "pending"
  | "running"
  | "received"
  | "succeeded"
  | "failed"
  | "result_unknown"
  | "cancelled";
export interface Constraints {
  interests: string;
  background: string;
  time: string;
  compute: string;
  data: string;
}
export interface SourceRef {
  libraryID: number;
  itemKey: string;
  attachmentKey?: string;
  annotationKey?: string;
}
export interface Evidence extends SourceRef {
  id: string;
  kind: "metadata" | "abstract" | "annotation" | "pdf_excerpt" | "manual";
  title: string;
  text: string;
  hash: string;
  extraction: string;
  pageLabel?: string;
  start?: number;
  end?: number;
  truncated: boolean;
}
export interface ModelConfig {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  outputTokenField: "max_tokens" | "max_completion_tokens";
  allowLocal: boolean;
}
export interface Budget {
  maxRequests: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxDurationMs: number;
}
export const DEFAULT_BUDGET: Budget = {
  maxRequests: 6,
  maxInputBytes: 96000,
  maxOutputTokens: 3000,
  requestTimeoutMs: 120000,
  maxDurationMs: 600000,
};
export interface Snapshot {
  protocolVersion: 1;
  constraints: Constraints;
  evidence: Evidence[];
  models: Record<Role, ModelConfig>;
  budget: Budget;
}
export interface Citation {
  evidenceId: string;
  quote: string;
}
export interface Claim {
  kind: "fact" | "inference" | "proposal";
  text: string;
  citations: Citation[];
}
export interface Candidate {
  id: string;
  title: string;
  question: string;
  rationale: string;
  claims: Claim[];
}
export interface Review {
  candidateId: string;
  assessment: string;
  claims: Claim[];
  objections: string[];
  unknowns: string[];
}
export interface CardContent {
  candidateId: string;
  title: string;
  question: string;
  motivation: string;
  claims: Claim[];
  differences: string;
  resources: string;
  minimumExperiment: string;
  stopConditions: string[];
  disagreements: string[];
  nextSteps: string[];
}
export interface ExploreOutput {
  candidates: Candidate[];
}
export interface ReviewOutput {
  reviews: Review[];
}
export interface SynthesisOutput {
  cards: CardContent[];
}
export type StepOutput = ExploreOutput | ReviewOutput | SynthesisOutput;
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface RunError {
  code: string;
  message: string;
}
export interface Attempt {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: StepState;
  raw?: string;
  usage?: Usage;
  error?: RunError;
}
export interface StepRecord {
  name: StepName;
  state: StepState;
  attempts: Attempt[];
  output?: StepOutput;
}
export interface Run {
  id: string;
  projectId: string;
  snapshot: Snapshot;
  fingerprint: string;
  state: RunState;
  steps: StepRecord[];
  requestsUsed: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  error?: RunError;
}
export interface Project {
  id: string;
  name: string;
  constraints: Constraints;
  evidence: Evidence[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface TopicCard {
  id: string;
  projectId: string;
  runId: string;
  generated: CardContent;
  edited?: CardContent;
  status: CardStatus;
  notes: string;
  revision: number;
  needsReview: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface ChatMessage {
  role: "system" | "user";
  content: string;
}
export interface ChatRequest {
  config: ModelConfig;
  messages: ChatMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}
export interface ChatResponse {
  content: string;
  usage: Usage;
}
export interface ChatTransport {
  complete(request: ChatRequest): Promise<ChatResponse>;
}
export interface ExplorerStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  saveProject(project: Project, expectedRevision?: number): Promise<Project>;
  listRuns(projectId: string): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  createRun(run: Run): Promise<void>;
  updateRun(id: string, change: (run: Run) => Run): Promise<Run>;
  listCards(projectId: string): Promise<TopicCard[]>;
  saveCard(card: TopicCard, expectedRevision?: number): Promise<TopicCard>;
}
export interface SelectionTarget extends SourceRef {
  title: string;
}
export interface EvidenceResult {
  evidence: Evidence[];
  warnings: string[];
}
export interface ProviderSettings {
  models: ModelConfig[];
  bindings: Record<Role, string>;
}
