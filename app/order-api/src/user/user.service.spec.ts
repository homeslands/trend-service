import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { repositoryMockFactory } from 'src/test-utils/repository-mock.factory';
import { MAPPER_MODULE_PROVIDER } from 'src/app/app.constants';
import { mapperMockFactory } from 'src/test-utils/mapper-mock.factory';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { MailService } from 'src/mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';
import { Role } from 'src/role/role.entity';
import { RoleEnum } from 'src/role/role.enum';
import { MailProducer } from 'src/mail/mail.producer';
import { Branch } from 'src/branch/branch.entity';
import { Logger } from '@nestjs/common';
import { Mapper } from '@automapper/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SharedBalanceService } from 'src/shared/services/shared-balance.service';
import { TransactionManagerService } from 'src/db/transaction-manager.service';
import { BranchUtils } from 'src/branch/branch.utils';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';
import { UpdateUserRoleRequestDto } from './user.dto';

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        MailService,
        ConfigService,
        MailProducer,
        {
          provide: 'BullQueue_mail',
          useValue: {},
        },
        { provide: MailerService, useValue: {} },
        {
          provide: getRepositoryToken(User),
          useValue: repositoryMockFactory,
        },
        {
          provide: getRepositoryToken(Role),
          useValue: repositoryMockFactory,
        },
        {
          provide: getRepositoryToken(Branch),
          useValue: repositoryMockFactory,
        },
        {
          provide: MAPPER_MODULE_PROVIDER,
          useValue: mapperMockFactory,
        },
        {
          provide: WINSTON_MODULE_NEST_PROVIDER,
          useValue: console,
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
        { provide: SharedBalanceService, useValue: {} },
        { provide: TransactionManagerService, useValue: {} },
        { provide: EventEmitter2, useValue: {} },
        { provide: BranchUtils, useValue: {} },
        { provide: SharedUserServiceClient, useValue: {} },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

// Khoi tao truc tiep (khong qua TestingModule) - UserService phu thuoc
// nhieu provider khong lien quan toi updateUserRole (SharedBalanceService,
// TransactionManagerService, EventEmitter2, BranchUtils...), chi can stub
// toi thieu de test day du logic createdAt. Xem
// issuses/sync-user-data-with-role.md muc 6.3.
describe('UserService.updateUserRole', () => {
  const staffRole = { id: 'role-staff', name: RoleEnum.Staff } as Role;
  const sharedUser = {
    id: 'shared-user-1',
    phonenumber: '0900000001',
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  const buildService = ({ existingLocalUser = null as User | null } = {}) => {
    const savedUsers: Partial<User>[] = [];

    const userRepository = {
      findOne: jest.fn().mockResolvedValue(existingLocalUser),
      create: jest.fn().mockImplementation((data: Partial<User>) => data as User),
      save: jest.fn().mockImplementation((user: Partial<User>) => {
        savedUsers.push(user);
        return Promise.resolve(user);
      }),
    } as unknown as Repository<User>;

    const roleRepository = {
      findOne: jest.fn().mockResolvedValue(staffRole),
    } as unknown as Repository<Role>;

    const sharedUserServiceClient = {
      lookupById: jest.fn().mockResolvedValue(sharedUser),
      lookupByPhonenumber: jest.fn().mockResolvedValue(sharedUser),
    } as unknown as SharedUserServiceClient;

    const service = new UserService(
      { get: jest.fn() } as unknown as ConfigService,
      userRepository,
      {} as Repository<Branch>,
      roleRepository,
      { map: jest.fn().mockReturnValue({}) } as unknown as Mapper,
      console as unknown as Logger,
      {} as SharedBalanceService,
      {} as TransactionManagerService,
      {} as EventEmitter2,
      {} as BranchUtils,
      sharedUserServiceClient,
    );

    return { service, savedUsers };
  };

  it('sets createdAt from shared-user (not the current time) when lazily creating the local row for the first time', async () => {
    const { service, savedUsers } = buildService({ existingLocalUser: null });
    const beforeCall = Date.now();

    await service.updateUserRole({
      phonenumber: sharedUser.phonenumber,
      role: 'staff',
    } as UpdateUserRoleRequestDto);

    expect(savedUsers).toHaveLength(1);
    expect(savedUsers[0].sharedUserId).toEqual(sharedUser.id);
    expect(savedUsers[0].createdAt).toEqual(new Date(sharedUser.createdAt));
    expect((savedUsers[0].createdAt as Date).getTime()).toBeLessThan(beforeCall);
  });

  it('does not overwrite createdAt when the local row already exists', async () => {
    const originalCreatedAt = new Date('2026-05-01T00:00:00.000Z');
    const { service, savedUsers } = buildService({
      existingLocalUser: {
        sharedUserId: sharedUser.id,
        phonenumber: sharedUser.phonenumber,
        createdAt: originalCreatedAt,
      } as User,
    });

    await service.updateUserRole({
      phonenumber: sharedUser.phonenumber,
      role: 'staff',
    } as UpdateUserRoleRequestDto);

    expect(savedUsers).toHaveLength(1);
    expect(savedUsers[0].createdAt).toEqual(originalCreatedAt);
  });
});
