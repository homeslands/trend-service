import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { User } from 'src/user/user.entity';
import { Role } from 'src/role/role.entity';
import { RoleEnum } from 'src/role/role.enum';
import { Repository } from 'typeorm';
import { AuthUtils } from '../../auth.utils';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';

// Khoi tao truc tiep (khong qua TestingModule) - JwtStrategy chi phu thuoc
// 5 provider, khong can dung ca bo may NestJS DI de test logic tao row lazy.
// Xem issuses/sync-user-data-with-role.md muc 6.3.
describe('JwtStrategy', () => {
  const sharedUser = {
    id: 'shared-user-1',
    phonenumber: '0900000001',
    isActive: true,
    // Ngay dang ky that ben shared-user - khac han gio "bay gio" (gio
    // validate() chay), de phan biet ro voi gio insert row cuc bo.
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  const customerRole = { id: 'role-customer', name: RoleEnum.Customer } as Role;

  const buildStrategy = () => {
    const createdUsers: Partial<User>[] = [];
    let localUserExists = false;

    const userRepository = {
      findOne: jest.fn().mockImplementation(() =>
        Promise.resolve(localUserExists ? ({ id: 'local-1' } as User) : null),
      ),
      create: jest.fn().mockImplementation((data: Partial<User>) => {
        createdUsers.push(data);
        return data as User;
      }),
      save: jest.fn().mockImplementation(async () => {
        localUserExists = true;
      }),
    } as unknown as Repository<User>;

    const roleRepository = {
      findOne: jest.fn().mockResolvedValue(customerRole),
    } as unknown as Repository<Role>;

    const authUtils = {
      buildScope: jest.fn().mockReturnValue('{}'),
      parseScope: jest.fn().mockReturnValue({}),
    } as unknown as AuthUtils;

    const sharedUserServiceClient = {
      lookupById: jest.fn().mockResolvedValue(sharedUser),
    } as unknown as SharedUserServiceClient;

    const strategy = new JwtStrategy(
      userRepository,
      roleRepository,
      authUtils,
      sharedUserServiceClient,
      console as any,
    );

    return { strategy, userRepository, createdUsers };
  };

  it('creates the local row with createdAt taken from shared-user, not the current time', async () => {
    const { strategy, createdUsers } = buildStrategy();
    const beforeCall = Date.now();

    await strategy.validate({ sub: sharedUser.id } as any);

    expect(createdUsers).toHaveLength(1);
    expect(createdUsers[0]).toMatchObject({
      sharedUserId: sharedUser.id,
      phonenumber: sharedUser.phonenumber,
    });
    // createdAt phai la ngay dang ky that (2026-08-01), khong phai gio test
    // chay (~now) - do la dung ca ket qua sai neu code lai de TypeORM tu
    // sinh @CreateDateColumn.
    expect(createdUsers[0].createdAt).toEqual(new Date(sharedUser.createdAt));
    expect((createdUsers[0].createdAt as Date).getTime()).toBeLessThan(
      beforeCall,
    );
  });

  it('throws UnauthorizedException when the shared-user account is locked', async () => {
    const { strategy } = buildStrategy();
    (strategy as any).sharedUserServiceClient.lookupById = jest
      .fn()
      .mockResolvedValue({ ...sharedUser, isActive: false });

    await expect(
      strategy.validate({ sub: sharedUser.id } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws ServiceUnavailableException when shared-user lookup fails', async () => {
    const { strategy } = buildStrategy();
    (strategy as any).sharedUserServiceClient.lookupById = jest
      .fn()
      .mockRejectedValue(new Error('network error'));

    await expect(
      strategy.validate({ sub: sharedUser.id } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
