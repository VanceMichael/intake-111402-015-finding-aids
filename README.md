# 档案检索指南的层级限制与数字对象采集

档案指南入口。已有叶节点摘要和来源 unitid 提取。网关使用 EAD 组件投影，数字对象是合成本地文件。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /entries 返回馆员投影（`?status=originals|catalog|restricted` 定位原件、目录记录与受限数字对象，`?guide=` 按指南过滤），GET /entries/:id/history 返回该条目全部保留版本，GET /health 检查服务。

```sh
docker build --network=none -t finding-aids .
docker run --rm --network=none finding-aids npm test
docker run --rm --network=none finding-aids npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。每个组件导出一行，保留完整层级路径、自身书写的描述与生效的继承上下文；只领取该组件自己声明的数字对象，外部指南引用保留为边界。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本；entries()/history() 供馆员定位与追溯。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
