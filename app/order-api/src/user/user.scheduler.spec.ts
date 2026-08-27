import { UserScheduler } from './user.scheduler';
import { User } from './user.entity';
import { Role } from './../role/role.entity';
import { RoleEnum } from './../role/role.enum';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { UserBirthdayProducer } from './user-birthday.producer';
import { CampaignService } from 'src/campaign/campaign.service';
import { Queue } from 'bullmq';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';

// Redlock that lam viec that (mo ket noi Redis that) - chi can gia lap
// acquire()/release() de test logic nghiep vu, khong test co che khoa phan
// tan (da co san o BirthdayStrategyScheduler, khong lap lai o day).
const releaseMock = jest.fn().mockResolvedValue(undefined);
const acquireMock = jest.fn().mockResolvedValue({ release: releaseMock });
jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({
    acquire: acquireMock,
  }));
});

// Khoi tao truc tiep (khong qua TestingModule) - UserScheduler phu thuoc
// nhieu provider khong lien quan (CampaignService, UserBirthdayProducer...)
// chi can stub toi thieu de test job moi. Xem
// issuses/sync-user-data-with-role.md muc 6.
describe('UserScheduler.syncRecentlyRegisteredUsers', () => {
  const customerRole = { id: 'role-customer', name: RoleEnum.Customer } as Role;

  beforeEach(() => {
    acquireMock.mockClear();
    releaseMock.mockClear();
  });

  const buildScheduler = ({
    recentSharedUsers = [] as any[],
    existingSharedUserIds = [] as string[],
  } = {}) => {
    const createdUsers: Partial<User>[] = [];

    const userRepository = {
      exists: jest.fn().mockImplementation(({ where: { sharedUserId } }) =>
        Promise.resolve(existingSharedUserIds.includes(sharedUserId)),
      ),
      create: jest.fn().mockImplementation((data: Partial<User>) => {
        createdUsers.push(data);
        return data as User;
      }),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<User>;

    const roleRepository = {
      findOne: jest.fn().mockResolvedValue(customerRole),
    } as unknown as Repository<Role>;

    const sharedUserServiceClient = {
      listRecent: jest.fn().mockResolvedValue(recentSharedUsers),
    } as unknown as SharedUserServiceClient;

    const distributeLockJobQueue = {
      client: Promise.resolve({}),
    } as unknown as Queue;

    const scheduler = new UserScheduler(
      userRepository,
      roleRepository,
      console as any,
      { get: jest.fn() } as unknown as ConfigService,
      {} as UserBirthdayProducer,
      {} as CampaignService,
      distributeLockJobQueue,
      sharedUserServiceClient,
    );

    return { scheduler, userRepository, sharedUserServiceClient, createdUsers };
  };

  it('creates a local row (role Customer) for each recently registered user missing locally, with createdAt from shared-user', async () => {
    const recentSharedUsers = [
      {
        id: 'shared-user-1',
        phonenumber: '0900000001',
        createdAt: '2026-08-24T10:00:00.000Z',
      },
      {
        id: 'shared-user-2',
        phonenumber: '0900000002',
        createdAt: '2026-08-24T11:00:00.000Z',
      },
    ];
    const { scheduler, createdUsers } = buildScheduler({ recentSharedUsers });

    await scheduler.syncRecentlyRegisteredUsers();

    expect(createdUsers).toHaveLength(2);
    expect(createdUsers[0]).toMatchObject({
      sharedUserId: 'shared-user-1',
      phonenumber: '0900000001',
      role: customerRole,
      createdAt: new Date('2026-08-24T10:00:00.000Z'),
    });
    expect(createdUsers[1]).toMatchObject({
      sharedUserId: 'shared-user-2',
      createdAt: new Date('2026-08-24T11:00:00.000Z'),
    });
  });

  it('skips users that already have a local row (idempotent, no duplicate insert)', async () => {
    const recentSharedUsers = [
      {
        id: 'shared-user-1',
        phonenumber: '0900000001',
        createdAt: '2026-08-24T10:00:00.000Z',
      },
    ];
    const { scheduler, createdUsers } = buildScheduler({
      recentSharedUsers,
      existingSharedUserIds: ['shared-user-1'],
    });

    await scheduler.syncRecentlyRegisteredUsers();

    expect(createdUsers).toHaveLength(0);
  });

  it('does nothing when shared-user returns no recently registered user', async () => {
    const { scheduler, userRepository } = buildScheduler({
      recentSharedUsers: [],
    });

    await scheduler.syncRecentlyRegisteredUsers();

    expect(userRepository.exists).not.toHaveBeenCalled();
  });

  it('releases the distributed lock even when an error is thrown mid-run', async () => {
    const { scheduler, sharedUserServiceClient } = buildScheduler();
    (sharedUserServiceClient.listRecent as jest.Mock).mockRejectedValue(
      new Error('shared-user unreachable'),
    );

    await scheduler.syncRecentlyRegisteredUsers();

    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('skips the run entirely when another replica already holds the lock', async () => {
    acquireMock.mockRejectedValueOnce(new Error('lock already held'));
    const { scheduler, sharedUserServiceClient } = buildScheduler();

    await scheduler.syncRecentlyRegisteredUsers();

    expect(sharedUserServiceClient.listRecent).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
