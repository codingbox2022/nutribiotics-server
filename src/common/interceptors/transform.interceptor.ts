import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse, PaginationMeta } from '../interfaces/response.interface';

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((response) => {
        // Check if response has pagination meta (from service)
        if (response && typeof response === 'object' && 'meta' in response) {
          const { data, meta } = response as {
            data: T;
            meta: { page: number; limit: number; total: number };
          };

          const totalPages = Math.ceil(meta.total / meta.limit);
          const paginationMeta: PaginationMeta = {
            page: meta.page,
            limit: meta.limit,
            total: meta.total,
            totalPages,
            hasNextPage: meta.page < totalPages,
            hasPrevPage: meta.page > 1,
          };

          return {
            success: true,
            data,
            message: 'OK',
            meta: paginationMeta,
            timestamp: new Date().toISOString(),
          };
        }

        // Standard response without pagination
        return {
          success: true,
          data: response as T,
          message: 'OK',
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
