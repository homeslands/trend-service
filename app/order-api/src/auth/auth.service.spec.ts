/* eslint-disable @typescript-eslint/no-unused-vars */
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { LoggerService } from 'src/logger/logger.service';
import {
  MockType,
  repositoryMockFactory,
} from 'src/test-utils/repository-mock.factory';
import { Repository } from 'typeorm';
import { User } from 'src/user/user.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { mapperMockFactory } from 'src/test-utils/mapper-mock.factory';
import { Mapper } from '@automapper/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { MAPPER_MODULE_PROVIDER } from 'src/app/app.constants';
import { Logger } from 'src/logger/logger.entity';
import { MailService } from 'src/mail/mail.service';
import { MailerService } from '@nestjs-modules/mailer';
import { SystemConfigService } from 'src/system-config/system-config.service';
import { SystemConfig } from 'src/system-config/system-config.entity';
import { MailProducer } from 'src/mail/mail.producer';
import { VerifyEmailToken } from './entity/verify-email-token.entity';
import { TransactionManagerService } from 'src/db/transaction-manager.service';
import { UserUtils } from 'src/user/user.utils';
import { ZaloOaConnectorConfig } from 'src/zalo-oa-connector/entity/zalo-oa-connector.entity';
import { ZaloOaConnectorClient } from 'src/zalo-oa-connector/zalo-oa-connector.client';
import { VerifyPhoneNumberToken } from './entity/verify-phone-number-token.entity';
import { HttpService } from '@nestjs/axios';
import { Balance } from 'src/gift-card-modules/balance/entities/balance.entity';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';

describe('AuthService', () => {
  let service: AuthService;
  let userRepositoryMock: MockType<Repository<User>>;
  let mapperMock: MockType<Mapper>;
  let systemConfigService: SystemConfigService;
  let userUtils: UserUtils;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        SystemConfigService,
        TransactionManagerService,
        UserUtils,
        ZaloOaConnectorClient,
        HttpService,
        {
          provide: getRepositoryToken(ZaloOaConnectorConfig),
          useFactory: repositoryMockFactory,
        },
        {
          provide: getRepositoryToken(VerifyPhoneNumberToken),
          useFactory: repositoryMockFactory,
        },
        {
          provide: getRepositoryToken(Balance),
          useFactory: repositoryMockFactory,
        },
        {
          provide: 'AXIOS_INSTANCE_TOKEN',
          useValue: {
            get: jest.fn(),
            post: jest.fn(),
          },
        },
        MailProducer,
        {
          provide: 'BullQueue_mail',
          useValue: {
            add: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(SystemConfig),
          useFactory: repositoryMockFactory,
        },
        {
          provide: getRepositoryToken(VerifyEmailToken),
          useFactory: repositoryMockFactory,
        },
        {
          provide: getRepositoryToken(User),
          useFactory: repositoryMockFactory,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'SALT_ROUNDS') {
                return 10;
              }
              return null;
            }),
          },
        },
        {
          provide: MAPPER_MODULE_PROVIDER,
          useFactory: mapperMockFactory,
        },
        {
          provide: WINSTON_MODULE_NEST_PROVIDER,
          useValue: console, // Mock logger (or a custom mock)
        },
        {
          provide: getRepositoryToken(Logger),
          useFactory: repositoryMockFactory,
        },
        MailService,
        { provide: MailerService, useValue: {} },
        LoggerService,
        {
          provide: SharedUserServiceClient,
          useValue: {
            lookupById: jest.fn(),
            lookupByPhonenumber: jest.fn(),
            lookupByIds: jest.fn(),
            createUser: jest.fn(),
            updateIdentity: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepositoryMock = module.get(getRepositoryToken(User));
    mapperMock = module.get(MAPPER_MODULE_PROVIDER);
    systemConfigService = module.get(SystemConfigService);
    userUtils = module.get(UserUtils);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Testing retrieve frontend url func', () => {
    it('Should return an empty value if the frontend url is not found', async () => {
      const frontendUrl = '';
      jest.spyOn(systemConfigService, 'get').mockResolvedValue(frontendUrl);
      expect(await service.getFrontendUrl()).toEqual(frontendUrl);
    });

    it('Should return an value if the frontend url is found', async () => {
      const frontendUrl = 'mock-frontend-url';
      jest.spyOn(systemConfigService, 'get').mockResolvedValue(frontendUrl);
      expect(await service.getFrontendUrl()).toEqual(frontendUrl);
    });
  });

  // updateProfile/uploadAvatar da bi xoa khoi AuthService (PATCH /auth/profile,
  // PATCH /auth/upload chuyen han sang shared-user) - test tuong ung cung xoa.

  afterEach(() => {
    jest.clearAllMocks();
  });
});
