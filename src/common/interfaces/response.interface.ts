export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  message: string;
  meta?: PaginationMeta;
  error?: {
    code: string;
    details?: unknown;
  };
  timestamp: string;
}
