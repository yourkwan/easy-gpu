/** SSH 认证失败：密码/密钥均不通过，或用户取消了密码输入。 */
export class SshAuthError extends Error {
  readonly cancelled: boolean;

  constructor(message: string, cancelled = false) {
    super(message);
    this.name = 'SshAuthError';
    this.cancelled = cancelled;
  }
}

/** 主机密钥与已记录的不一致（可能是中间人攻击，也可能是服务器重装过）。 */
export class SshHostKeyError extends Error {
  readonly fingerprint?: string;

  constructor(message: string, fingerprint?: string) {
    super(message);
    this.name = 'SshHostKeyError';
    this.fingerprint = fingerprint;
  }
}