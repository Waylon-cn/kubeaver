const util = require('util');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const { getNodeStatus, getRedis } = require('../utils/getNodeStatus');
const { createAnsibleQueue, queues } = require('../utils/ansibleQueue');
const { getNodeList } = require('./node')
const { getDatabaseByK8sVersion } = require('../utils/getDatabase');
//redis一直处于连接
const redisConfig = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
};

const redis = new Redis(redisConfig);

//查找具体的某个任务的哈希值,prefix 'k8s_cluster:test:tasks:' suffix  '123456789'  
async function findHashKeys(prefix, suffix) {
  const nodekey = []; // 存储找到的哈希键
  let cursor = '0';
  do {
    // 使用 SCAN 命令查找所有匹配的键
    const result = await redis.scan(cursor, 'MATCH', `${prefix}*`);
    cursor = result[0]; // 更新游标
    const foundKeys = result[1]; // 找到的键
    // 检查每个键是否包含 IP 部分
    for (const key of foundKeys) {
      if (key.includes(suffix)) {
        nodekey.push(key); // 添加到结果中
      }
    }
  } while (cursor !== '0'); // 直到游标返回到 0
  return nodekey;
}


//获取集群列表
async function getK8sCluster() {
  const clusterInfoData = [];
  const prefix = `k8s_cluster:`;
  const suffix = `:baseInfo`;
  try {
    //获取节点总数以及readyde 数量
    const hashKeys = await findHashKeys(prefix, suffix);
    for (const itemClusterInfo of hashKeys) {
      const output = await redis.hgetall(itemClusterInfo);
      output.id = itemClusterInfo.replace(prefix, '').replace(suffix, '');
      if (!output.clusterName) {
        console.log("集群删除了！！！！！");
        await deleteK8sCluster(output.id); // 删除没有 clusterName 的数据
        continue;
      }
      const nodeData = await getNodeList(output.id)
      output.nodeTotalNum = nodeData.data.length || 0;
      output.masterCount = nodeData.data.filter(node => node.role === 'master').length || 0;
      output.masterReadyNum = nodeData.data.filter(node => node.status === 'Ready').length || 0;
      output.nodeCount = nodeData.data.filter(node => node.role === 'node').length || 0;
      // //获取每个类型任务中活跃任务数和等待任务数
      // const taskNames = [
      //   "initCluster",
      //   "addNode",
      //   "resetNode",
      //   "resetCluster",
      //   "upgradeCluster",
      // ]
      // for (const taskName of taskNames) {
      //   const queueId = `${output.id}_${taskName}`;
      //   try {
      //     activeJobsData = await getActiveJobs(queueId);
      //   } catch (error) {
      //     //console.error(`Error retrieving active jobs for queue ${queueId}:`, error);
      //     activeJobsData = [];
      //   }

      //   try {
      //     waitingJobsData = await getWaitingJobs(queueId);
      //   } catch (error) {
      //     //console.error(`Error retrieving waiting jobs for queue ${queueId}:`, error);
      //     waitingJobsData = [];
      //   }

      //   const activeCount = activeJobsData.length || 0;
      //   const waitingCount = waitingJobsData.length || 0;
      //   output[`${taskName}`] = activeCount + waitingCount;
      // }

      clusterInfoData.push(output);
    }
    // 异步查询集群状态并更新 Redis
    const statusPromises = clusterInfoData.map(async (item) => {
      try {
        const resultData = await getRedis(item.id);

        //先查询集群基本信息是否存在，如果存在更新状态，如果不存在不要更新状态。
        if (!resultData.clusterName) {
          console.error(`集群不存在，跳过更新状态`);
          return;
        }
        // 节点只要有一个master是ready,整个集群状态为ready
        let isClusterReady = false;
        for (const node of resultData.hosts) {
          if (node.role === "master") {
            const hostName = node.hostName;
            let masterIP = node.ip;
            let result;
            try {
              const updateTime = Date.now();
              result = await getNodeStatus(item.id, hostName, '', masterIP);
              if (result.status) {
                if (result.status === 'Ready') {
                  isClusterReady = true;
                  const nodeKey = `k8s_cluster:${item.id}:baseInfo`;
                  await redis.hset(nodeKey,
                    'status', 'Ready',
                    'updateTime', updateTime
                  );
                  break; // Exit the loop early if a ready master is found
                }
              } else {
                console.error(`未能获取到${item.id}:${hostName}节点状态，直接返回`);
                return;
              }
            } catch (error) {
              console.error(`获取节点状态时出错: ${error.message}`);
            }
          }
        }
        if (!isClusterReady) {
          const nodeKey = `k8s_cluster:${item.id}:baseInfo`;
          await redis.hset(nodeKey,
            'status', 'Unknown',
            'updateTime', Date.now()
          );
        }
      } catch (error) {
        console.error(`获取 Redis 数据时出错: ${error.message}`);
      }
    });

    Promise.all(statusPromises).catch(error => {
      console.error(`异步查询集群状态时出错: ${error.message}`);
    });

    return {
      code: 20000,
      data: clusterInfoData,
      msg: "获取集群列表成功",
      status: "ok"
    };
  } catch (error) {
    console.log('获取集群列表时发生错误:', error.message || error);
    return {
      code: 50000,
      data: clusterInfoData,
      msg: error.message,
      status: "error"
    };
  }
}

//创建集群
async function createK8sCluster(clusterInfo) {
  try {
    //先检查集群名称是否存在，先通过查询所有的redis数据，然后匹配
    const returnClusterData = await findHashKeys("k8s_cluster:", "baseInfo")
    for (const itemCluster of returnClusterData) {
      k8sBaseInfo = await redis.hgetall(itemCluster);
      if (k8sBaseInfo.clusterName == clusterInfo.clusterName) {
        return {
          code: 10001,
          status: "error",
          msg: "集群名称已经存在！"
        };
      }
    }
    // 存储每个集群基本信息
    const customAlphabet = (await import('nanoid/non-secure')).customAlphabet;
    const customNanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);
    const clusterKey = customNanoid();
    const nodeKey = `k8s_cluster:${clusterKey}:baseInfo`;
    const createTime = Date.now();
    //找出role为master的第一个值clusterInfo.hosts
    const masterNode = clusterInfo.hosts.find(node => node.role === 'master');
    console.log(masterNode)
    if (!masterNode) {
      return {
        code: 10004,
        status: "error",
        msg: "集群中必须包含至少一个master节点！"
      };
    }
    await redis.hset(
      nodeKey,
      'clusterName', clusterInfo.clusterName,
      'version', clusterInfo.version,
      'networkPlugin', clusterInfo.networkPlugin,
      'taskProcess', 'Unknown',
      'status', 'Unknown',
      'taskNum', clusterInfo.taskNum,
      'createTime', createTime,
      'updateTime', createTime,
      'master1', masterNode.hostName,
    );
    //initQueue(); //初始化操作同步进行
    //在不同库创建相应的队列
    await createAnsibleQueue(clusterKey, parseInt(clusterInfo.taskNum, 10), clusterInfo.version);
    //目前先增加主机数据
    for (const newNode of clusterInfo.hosts) {
      const hostsNodeKey = `k8s_cluster:${clusterKey}:hosts:${newNode.ip}`;
      await redis.hset(hostsNodeKey,
        'ip', newNode.ip,
        'hostName', newNode.hostName,
        'user', newNode.user,
        'role', newNode.role,
        'os', newNode.os,
        'k8sVersion', 'Unknown',
        'status', 'Unknown',
        'createTime', createTime,
        'updateTime', createTime
      );
    }

    return {
      code: 20000,
      msg: "创建集群成功",
      status: "ok"
    }
  } catch (error) {
    console.log(error)
    return {
      code: 50000,
      status: error,
      msg: error.message
    }
  }
}

async function updateK8sCluster(clusterInfo) {
  //先清空hosts
  const hashKey = `k8s_cluster:${clusterInfo.id}:hosts:*`;
  let nodeKeys;
  try {
    nodeKeys = await redis.keys(hashKey);
  } catch (error) {
    console.error('查询哈希值发生错误:', error.message || error);
    return {
      code: 50000,
      msg: error.message,
      status: "error"
    }
  }
  for (const nodeKey of nodeKeys) {
    try {
      const result = await redis.del(nodeKey);
      if (result === 1) {
        console.log(`成功删除哈希表 ${nodeKey}。`);
      } else {
        console.log(`哈希表 ${nodeKey} 不存在，无法删除。`);
      }
    } catch (error) {
      return {
        code: 50000,
        status: "error",
        msg: "删除hosts失败。"
      };
    }
  }
  try {
    //更新之前要判断更新的内容里面是否更新集群名称与所有集群内的是否相同(值得注意的是需要去除当前id查询。)
    const returnClusterData = await findHashKeys("k8s_cluster:", "baseInfo")
    //去除当前id
    const filterHostKey = `k8s_cluster:${clusterInfo.id}:baseInfo`
    const filterClusterData = returnClusterData.filter(item => item !== filterHostKey);
    for (const itemCluster of filterClusterData) {
      k8sBaseInfo = await redis.hgetall(itemCluster);

      if (k8sBaseInfo.clusterName == clusterInfo.clusterName) {
        return {
          code: 10001,
          status: "error",
          msg: "集群名称已经存在，请重新修改集群名称。"
        };
      }
    }
    const masterNode = clusterInfo.hosts.find(node => node.role === 'master');
    const nodeKey = `k8s_cluster:${clusterInfo.id}:baseInfo`;
    const updateTime = Date.now();
    await redis.hset(nodeKey,
      'clusterName', clusterInfo.clusterName,
      'version', clusterInfo.version,
      'networkPlugin', clusterInfo.networkPlugin,
      'taskNum', clusterInfo.taskNum,
      'taskProcess', 'Unknown',
      'status', 'Unknown',//集群实际状态
      'updateTime', updateTime,
      'master1', masterNode.hostName,
    );
    //initQueue();
    await createAnsibleQueue(clusterInfo.id, parseInt(clusterInfo.taskNum, 10), clusterInfo.version);
    //目前先增加主机数据
    for (const newNode of clusterInfo.hosts) {
      const hostsNodeKey = `k8s_cluster:${clusterInfo.id}:hosts:${newNode.ip}`;
      await redis.hset(hostsNodeKey,
        'ip', newNode.ip,
        'hostName', newNode.hostName,
        'user', newNode.user,
        'role', newNode.role,
        'os', newNode.os,
        'status', 'Unknown',
        'createTime', updateTime,
        'updateTime', updateTime,
        'lastJobType', newNode.lastJobType || '',
        'lastJobStatus', newNode.lastJobStatus || '',
      );
    }


    return {
      code: 20000,
      msg: "更新集群成功",
      status: "ok"
    }
  } catch (error) {
    console.log(error)
    return {
      code: 50000,
      status: error,
      msg: error.message
    }
  }
}

// async function deleteK8sCluster(id) {
//   //先删除inventory-clusterId文件夹
//   //const currentDir = process.cwd();
//   const inventoryDir = path.join(__dirname, '../data/inventory', `inventory-${id}`);
//   // 使用相对路径
//   //const inventoryDir = path.join(currentDir, '/data/inventory', `inventory-${id}`);
//   try {
//     if (fs.existsSync(inventoryDir)) {
//       fs.rmSync(inventoryDir, { recursive: true, force: true });
//       console.log(`成功删除目录: ${inventoryDir}`);
//     } else {
//       console.log(`目录不存在: ${inventoryDir}`);
//     }
//   } catch (error) {
//     console.error(`删除目录时出错: ${error.message}`);
//     return {
//       code: 50001,
//       msg: '删除目录时出错',
//       status: 'error'
//     };
//   }
//   //删除记录的集群信息
//   bullHashKeys = `bull:${id}*:*`
//   k8sHashKeys = `k8s_cluster:${id}:*`
//   let deleteHashKeys = [bullHashKeys, k8sHashKeys]
//   const keys = [];
//   let cursor = '0';
//   for (const pattern of deleteHashKeys) {
//     do {
//       const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
//       cursor = result[0]; // 更新游标
//       keys.push(...result[1]); // 添加找到的键
//     } while (cursor !== '0'); // 当游标为 0 时停止
//   }
//   if (keys.length > 0) {
//     // 删除找到的所有键
//     await redis.del(...keys);
//     //console.log(`Deleted keys: ${keys.join(', ')}`);
//   } else {
//     return {
//       code: 20001,
//       msg: '未找到删除相关的值',
//       status: 'ok'
//     };
//   }
//   return {
//     code: 20000,
//     msg: '删除成功',
//     status: 'ok'
//   };
// }
async function deleteK8sCluster(id) {
  // 1. 删除本地文件
  const inventoryDir = path.join(__dirname, '../data/inventory', `inventory-${id}`);
  try {
    if (fs.existsSync(inventoryDir)) {
      fs.rmSync(inventoryDir, { recursive: true, force: true });
      console.log(`Deleted directory: ${inventoryDir}`);
    }
  } catch (error) {
    console.error(`File deletion error: ${error.message}`);
    return { code: 50001, msg: '文件删除失败', status: 'error' };
  }

  // 2. 获取集群版本（从db0的Hash结构）
  let k8sVersion;
  let baseInfo;
  try {
    baseInfo = await redis.hgetall(`k8s_cluster:${id}:baseInfo`);
    if (!baseInfo || Object.keys(baseInfo).length === 0) {
      // 没有任何信息，直接清理所有相关key
      k8sVersion = null;
    } else if (!baseInfo.version) {
      // 没有version字段，说明是脏数据，也要清理
      console.log(`集群${id} baseInfo为脏数据，强制清理所有相关key`);
      k8sVersion = null;
    } else {
      k8sVersion = baseInfo.version;
    }
  } catch (error) {
    console.error(`Version check error: ${error.message}`);
    return { code: 50002, msg: '获取版本失败', status: 'error' };
  }

  // 3. 删除操作（分数据库处理）
  try {
    // 3.1 始终在db0删除k8s_cluster键
    await redis.select(0);
    const clusterKeys = await scanKeys(`k8s_cluster:${id}:*`);
    if (clusterKeys.length > 0) {
      await redis.del(clusterKeys);
      console.log(`Deleted ${clusterKeys.length} cluster keys in db0`);
    }

    // 3.2 在目标库删除bull键
    const targetDb = await getDatabaseByK8sVersion(k8sVersion);
    await redis.select(targetDb);
    const bullKeys = await scanKeys(`bull:${id}*:*`);
    if (bullKeys.length > 0) {
      await redis.del(bullKeys);
      console.log(`Deleted ${bullKeys.length} bull keys in db${targetDb}`);
    }

    return {
      code: 20000,
      msg: `删除完成 (cluster:${clusterKeys.length}, bull:${bullKeys.length})`,
      status: 'ok'
    };

  } catch (error) {
    console.error(`Deletion error: ${error.message}`);
    return { code: 50003, msg: '删除过程出错', status: 'error' };
  } finally {
    await redis.select(0); // 恢复默认db0
  }
}

// 辅助函数：SCAN遍历键
async function scanKeys(pattern) {
  let keys = [];
  let cursor = '0';
  do {
    const reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = reply[0];
    keys.push(...reply[1]);
  } while (cursor !== '0');
  return keys;
}

async function getK8sConfigFile(id) {
  //从redis中获取config文件
  const configHashKey = `k8s_cluster:${id}:config`;
  try {
    const configFile = await redis.get(configHashKey);
    if (!configFile) {
      console.error(`未找到配置文件: ${configHashKey}`);
      return {
        code: 20001,
        msg: '未找到config文件',
        status: 'ok'
      };
    }
    return {
      code: 20000,
      data: configFile,
      msg: "获取config文件成功",
      status: "ok"
    };
  } catch (error) {
    console.error(`从 Redis 获取配置文件时出错: ${error.message}`);
    return {
      code: 50000,
      msg: error.message,
      status: error,
    };
  }

}


module.exports = {
  getK8sCluster,
  createK8sCluster,
  updateK8sCluster,
  deleteK8sCluster,
  getK8sConfigFile,
}