import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { jwtConstants } from '../../constants';
import { AuthJwtPayload } from '../../auth.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from 'src/user/user.entity';
import { Repository } from 'typeorm';
import { CurrentUserDto } from 'src/user/user.dto';
import { AuthUtils } from '../../auth.utils';
import { Role } from 'src/role/role.entity';
import { RoleEnum } from 'src/role/role.enum';
import {
  SharedUserLookupResponse,
  SharedUserServiceClient,
} from 'src/external-services/shared-user-service/shared-user-service.client';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

const RELATIONS = [
  'role.permissions.authority.authorityGroup',
  'branch.addressDetail',
];

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    private readonly authUtils: AuthUtils,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConstants.publicKey,
      algorithms: [jwtConstants.algorithm],
      usernameField: 'phonenumber',
    });
  }

  async validate(payload: AuthJwtPayload) {
    const context = `${JwtStrategy.name}.${this.validate.name}`;

    // Khoa/mo khoa tai khoan quy het ve shared-user (architect-http.md muc
    // 1.1) - trend khong con giu ban isActive cua rieng no nua (ve sau
    // user_tbl chi con sharedUserId + role + branch), nen MOI request co
    // auth deu phai hoi lai identity that + trang thai khoa qua day, khong
    // dung du lieu cuc bo. Xem issuses/sync-user-data-with-role.md.
    const sharedUser = await this.sharedUserServiceClient
      .lookupById(payload.sub)
      .catch((error) => {
        this.logger.error(
          `Error looking up shared-user by id: ${error.message}`,
          error.stack,
          context,
        );
        throw new ServiceUnavailableException();
      });
    // Token da verify hop le bang public key cua shared-user, nen ve ly
    // thuyet luon tra ve duoc user - null chi xay ra neu tai khoan da bi
    // xoa ben shared-user sau khi token duoc phat hanh.
    if (!sharedUser) throw new UnauthorizedException();
    // Tai khoan bi khoa - chan hoan toan, khong cho request di tiep.
    if (!sharedUser.isActive) throw new UnauthorizedException();

    let user = await this.userRepository.findOne({
      where: {
        sharedUserId: payload.sub,
      },
      relations: RELATIONS,
    });

    if (!user) {
      // Lan dau user nay xuat hien o trend (vd vua tu dang ky ben
      // shared-user, chua ai o trend gan role cho ho) - tu tao row toi
      // gian voi role Customer mac dinh, chan (block) request lai cho toi
      // khi tao xong, khong tra role=null nhu truoc nua. Xem thiet ke +
      // ly do tai issuses/sync-user-data-with-role.md.
      user = await this.createLocalUserWithDefaultRole(sharedUser);
    }

    const scope = this.authUtils.buildScope(user);
    return {
      // userId = id CUC BO cua trend (user_tbl.id), KHONG phai payload.sub
      // (id ben shared-user). Moi noi tieu thu CurrentUserDto trong trend
      // deu dung field nay de tra row cuc bo / gan quan he (vd
      // AuthService.getProfile, PaymentService, UserGroupService.create...),
      // nen tra payload.sub vao day se lam moi query cuc bo truot -> loi
      // USER_NOT_FOUND. Muon lay id ben shared-user thi doc user.sharedUserId.
      userId: user.id,
      scope: this.authUtils.parseScope(scope),
    } as CurrentUserDto;
  }

  private async createLocalUserWithDefaultRole(
    sharedUser: SharedUserLookupResponse,
  ): Promise<User> {
    const context = `${JwtStrategy.name}.${this.createLocalUserWithDefaultRole.name}`;

    const customerRole = await this.roleRepository.findOne({
      where: { name: RoleEnum.Customer },
    });
    if (!customerRole) {
      this.logger.error(`Role ${RoleEnum.Customer} not found`, null, context);
      throw new ServiceUnavailableException();
    }

    try {
      const newUser = this.userRepository.create({
        sharedUserId: sharedUser.id,
        phonenumber: sharedUser.phonenumber,
        role: customerRole,
        // Ngay dang ky that ben shared-user - KHONG de @CreateDateColumn tu
        // sinh theo gio tao row nay (gio dang nhap lan dau, khong phai gio
        // dang ky), xem issuses/sync-user-data-with-role.md muc 6.3.
        createdAt: new Date(sharedUser.createdAt),
      });
      await this.userRepository.save(newUser);
    } catch (error) {
      // Race: 2 request dau tien cua cung 1 user toi gan nhau, ca 2 deu
      // thay chua co row roi cung insert - 1 trong 2 se vi pham unique
      // constraint (sharedUserId/phonenumber). Khong coi la loi, chi can
      // doc lai row do request kia da tao thanh cong.
      this.logger.warn(
        `Insert local user raced or failed, re-reading: ${error.message}`,
        context,
      );
    }

    const user = await this.userRepository.findOne({
      where: { sharedUserId: sharedUser.id },
      relations: RELATIONS,
    });
    if (!user) throw new ServiceUnavailableException();
    return user;
  }
}
