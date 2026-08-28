import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoggerService } from 'src/logger/logger.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from 'src/user/user.entity';
import { repositoryMockFactory } from 'src/test-utils/repository-mock.factory';
import { mapperMockFactory } from 'src/test-utils/mapper-mock.factory';
import { ConfigService } from '@nestjs/config';
import { MAPPER_MODULE_PROVIDER } from 'src/app/app.constants';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Logger } from 'src/logger/logger.entity';
import { MailService } from 'src/mail/mail.service';
import { MailerService } from '@nestjs-modules/mailer';
import { SystemConfig } from 'src/system-config/system-config.entity';
import { SystemConfigService } from 'src/system-config/system-config.service';
import { DataSource } from 'typeorm';
import { dataSourceMockFactory } from 'src/test-utils/datasource-mock.factory';
import { MailProducer } from 'src/mail/mail.producer';
import { VerifyEmailToken } from './entity/verify-email-token.entity';
import { TransactionManagerService } from 'src/db/transaction-manager.service';
import { UserUtils } from 'src/user/user.utils';
import { VerifyPhoneNumberToken } from './entity/verify-phone-number-token.entity';
import { ZaloOaConnectorClient } from 'src/zalo-oa-connector/zalo-oa-connector.client';
import { ZaloOaConnectorConfig } from 'src/zalo-oa-connector/entity/zalo-oa-connector.entity';
import { HttpService } from '@nestjs/axios';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        SystemConfigService,
        MailProducer,
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
          provide: 'AXIOS_INSTANCE_TOKEN',
          useValue: {
            get: jest.fn(),
            post: jest.fn(),
          },
        },
        {
          provide: 'BullQueue_mail',
          useValue: {},
        },
        { provide: DataSource, useFactory: dataSourceMockFactory },
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
          provide: getRepositoryToken(Logger),
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
        LoggerService,
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

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
