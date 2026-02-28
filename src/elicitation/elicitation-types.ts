export type ElicitationOption = {
  label: string;
  value: string;
  description?: string;
};

export type ElicitationType = 'free_text' | 'single_select' | 'multi_select' | 'confirm';

export type ElicitationRequest = {
  id: string;
  question: string;
  type: ElicitationType;
  options?: ElicitationOption[];
  defaultValue?: string;
  metadata?: Record<string, unknown>;
};

export type ElicitationResponse = {
  requestId: string;
  answer: string | string[];
  respondedAt: number;
};

export type PendingElicitation = {
  request: ElicitationRequest;
  createdAt: number;
};
