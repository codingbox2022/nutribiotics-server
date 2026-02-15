import { Test, TestingModule } from '@nestjs/testing';
import { ProductsController } from './products.controller';
import { getQueueToken } from '@nestjs/bullmq';

// Mock the service module to avoid running its imports
jest.mock('./products.service', () => ({
  ProductsService: class MockProductsService {},
}));

import { ProductsService } from './products.service';

describe('ProductsController', () => {
  let controller: ProductsController;
  let productsService: ProductsService;
  let queue: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn(),
            createBulk: jest.fn(),
            findPending: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            addComparables: jest.fn(),
          },
        },
        {
          provide: getQueueToken('product-discovery'),
          useValue: {
            add: jest.fn().mockResolvedValue({ id: 'job-123' }),
            getJob: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ProductsController>(ProductsController);
    productsService = module.get<ProductsService>(ProductsService);
    queue = module.get(getQueueToken('product-discovery'));
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('processNutribioticsProducts', () => {
    it('should add job to queue without productId when no body provided', async () => {
        // @ts-ignore - Argument of type 'undefined' is not assignable to parameter of type '{ productId?: string | undefined; }'.
      await controller.processNutribioticsProducts(undefined);
      expect(queue.add).toHaveBeenCalledWith('discover-products', {
        timestamp: expect.any(Date),
        triggeredBy: 'user',
        productId: undefined,
      });
    });

    it('should add job to queue with productId when body provided', async () => {
      const productId = 'product-123';
      await controller.processNutribioticsProducts({ productId });
      expect(queue.add).toHaveBeenCalledWith('discover-products', {
        timestamp: expect.any(Date),
        triggeredBy: 'user',
        productId,
      });
    });
  });
});
